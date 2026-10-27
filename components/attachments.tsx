"use client";

import { useCallback, useState } from "react";
import { XIcon } from "lucide-react";
import { findImagePaths, type AttachmentRef } from "@/src/core";

/**
 * The composer's image attachments (LH-39). Pasted and dropped images
 * upload their bytes; image paths typed or pasted into the text are
 * copied server-side at send time. Either way the server keeps its own
 * content-addressed copy (POST /api/attachments) and the message carries
 * only the reference. When the chat's model can't read images, nothing
 * attaches and the composer says so (`notice`) — never a silent drop.
 */

/** The composer-side state: pending refs, the notice line, and the
 *  three intake paths. `imagesBlocked` is the refusal text for the chat's
 *  current model (null = images allowed). */
export function useAttachments(imagesBlocked: string | null) {
	const [items, setItems] = useState<AttachmentRef[]>([]);
	const [notice, setNotice] = useState<string | null>(null);

	const addFiles = useCallback(
		async (files: File[]) => {
			const images = files.filter((f) => f.type.startsWith("image/"));
			if (images.length === 0) return;
			if (imagesBlocked) {
				setNotice(imagesBlocked);
				return;
			}
			setNotice(null);
			for (const file of images) {
				const form = new FormData();
				form.append("file", file, file.name);
				const res = await fetch("/api/attachments", { method: "POST", body: form });
				const body = (await res.json().catch(() => ({}))) as { attachment?: AttachmentRef; error?: string };
				if (body.attachment) {
					const ref = body.attachment;
					setItems((prev) => (prev.some((p) => p.id === ref.id) ? prev : [...prev, ref]));
				} else setNotice(body.error ?? `The image could not be attached (${res.status}).`);
			}
		},
		[imagesBlocked],
	);

	/** Lift every image path in `text` into the store: attached paths leave
	 *  the text (the stored copy replaces them); paths that fail stay as
	 *  typed. Returns the text to send and the refs to send with it. */
	const takePaths = useCallback(
		async (text: string): Promise<{ text: string; refs: AttachmentRef[] }> => {
			const found = findImagePaths(text);
			if (found.length === 0) return { text, refs: items };
			if (imagesBlocked) {
				setNotice(`${imagesBlocked} The path was sent as text.`);
				return { text, refs: items };
			}
			const refs = [...items];
			let out = text;
			for (const hit of [...found].reverse()) {
				const res = await fetch("/api/attachments", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: hit.path }),
				}).catch(() => null);
				const body = (await res?.json().catch(() => ({}))) as { attachment?: AttachmentRef } | undefined;
				if (!body?.attachment) continue;
				if (!refs.some((r) => r.id === body.attachment!.id)) refs.unshift(body.attachment);
				out = out.slice(0, hit.start) + out.slice(hit.end);
			}
			return { text: out.replace(/[ \t]{2,}/g, " ").trim(), refs };
		},
		[items, imagesBlocked],
	);

	const remove = useCallback((id: string) => setItems((prev) => prev.filter((p) => p.id !== id)), []);
	const clear = useCallback(() => {
		setItems([]);
		setNotice(null);
	}, []);

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
