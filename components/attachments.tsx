"use client";

import { useCallback, useState } from "react";
import { XIcon } from "lucide-react";
import { findImagePaths, IMAGES_UNSUPPORTED_CODE, type AttachmentRef } from "@/src/core";

/**
 * The composer's image attachments (LH-39). Pasted and dropped images
 * upload their bytes; image paths typed or pasted into the text are
 * copied server-side at send time. Either way the server keeps its own
 * content-addressed copy (POST /api/attachments) and the message carries
 * only the reference. When the chat's model can't read images, the server
 * refuses the intake and the composer says so (`notice`) — never a
 * silent drop.
 */

/** The composer-side state for one chat: pending refs, the notice line,
 *  and the intake paths. Every upload names the chat, so the server
 *  refuses images the chat's model can't read and the refusal becomes
 *  the notice. */
export function useAttachments(chatId: string) {
	const [items, setItems] = useState<AttachmentRef[]>([]);
	const [notice, setNotice] = useState<string | null>(null);

	/** POST one intake; the ref, or the server's refusal text. */
	const upload = useCallback(
		async (body: FormData | { path: string }): Promise<{ ref?: AttachmentRef; error?: string; refused?: boolean }> => {
			const res = await fetch("/api/attachments", body instanceof FormData
				? { method: "POST", body }
				: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, chatId }) },
			).catch(() => null);
			const json = (await res?.json().catch(() => ({}))) as { attachment?: AttachmentRef; error?: string; code?: string } | undefined;
			if (json?.attachment) return { ref: json.attachment };
			return { error: json?.error ?? "The image could not be attached.", refused: json?.code === IMAGES_UNSUPPORTED_CODE };
		},
		[chatId],
	);

	const addFiles = useCallback(
		async (files: File[]) => {
			setNotice(null);
			for (const file of files) {
				const form = new FormData();
				form.append("chatId", chatId);
				form.append("file", file, file.name);
				const { ref, error } = await upload(form);
				if (ref) setItems((prev) => (prev.some((p) => p.id === ref.id) ? prev : [...prev, ref]));
				else setNotice(error!);
			}
		},
		[chatId, upload],
	);

	/** Lift every image path in `text` into the store: attached paths leave
	 *  the text (the stored copy replaces them); paths that fail stay as
	 *  typed. Returns the text to send and the refs to send with it. */
	const takePaths = useCallback(
		async (text: string): Promise<{ text: string; refs: AttachmentRef[] }> => {
			const refs = [...items];
			let out = text;
			for (const hit of findImagePaths(text).reverse()) {
				const { ref, error, refused } = await upload({ path: hit.path });
				if (refused) {
					setNotice(`${error} The path was sent as text.`);
					break;
				}
				if (!ref) continue;
				if (!refs.some((r) => r.id === ref.id)) refs.unshift(ref);
				out = out.slice(0, hit.start) + out.slice(hit.end);
			}
			return { text: out === text ? text : out.replace(/[ \t]{2,}/g, " ").trim(), refs };
		},
		[items, upload],
	);

	const remove = useCallback((id: string) => setItems((prev) => prev.filter((p) => p.id !== id)), []);
	const clear = useCallback(() => setItems([]), []);

	return { items, notice, addFiles, takePaths, remove, clear };
}

/** The pending thumbnails above the composer's text row. */
export function AttachmentChips({ items, onRemove }: { items: AttachmentRef[]; onRemove: (id: string) => void }) {
	if (items.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5 px-1.5 pt-1.5">
			{items.map((ref) => (
				<span
					key={ref.id}
					data-testid="attachment-chip"
					className="relative size-14 overflow-hidden rounded-[10px] border border-border bg-background"
				>
					{/* Store bytes served locally; no Next image optimization. */}
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src={`/api/attachments/${ref.id}`} alt={ref.name ?? "Attached image"} className="size-full object-cover" />
					<button
						type="button"
						aria-label="Remove image"
						onClick={() => onRemove(ref.id)}
						className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-background/90 text-foreground hover:bg-accent"
					>
						<XIcon className="size-3" />
					</button>
				</span>
			))}
		</div>
	);
}

/** One sent image in the transcript, loaded from the store. */
export function AttachmentImage({ attachment }: { attachment: AttachmentRef }) {
	// Store bytes served locally; no Next image optimization.
	return (
		// eslint-disable-next-line @next/next/no-img-element
		<img
			data-testid="user-message-image"
			src={`/api/attachments/${attachment.id}`}
			alt={attachment.name ?? "Attached image"}
			className="mt-1 max-h-64 max-w-full rounded-[10px] border border-border"
		/>
	);
}
