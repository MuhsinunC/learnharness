"use client";

import { useCallback, useState } from "react";
import { XIcon } from "lucide-react";
import { findImagePaths, IMAGES_UNSUPPORTED_CODE, MAX_ATTACHMENT_BYTES, type AttachmentRef } from "@/src/core";

/**
 * The composer's image attachments (LH-39). Pasted and dropped images,
 * and image paths typed or pasted into the text (read through POST
 * /api/attachments/file at send time), all take one road: fitted here —
 * longest edge at most MAX_IMAGE_EDGE, re-encoded under the byte cap —
 * then uploaded, so the server keeps its own content-addressed copy and
 * the message carries only the reference. When the chat's model can't
 * read images, the server refuses the intake and the composer says so
 * (`notice`) — never a silent drop.
 */

/** Longest edge the composer keeps: past 20 images per request Claude
 *  takes nothing above ~2000 px, and screenshots read fine at this size. */
export const MAX_IMAGE_EDGE = 2000;

/** Downscale and re-encode an image that is too big in pixels or bytes;
 *  anything already within both limits uploads byte-for-byte. What still
 *  can't fit uploads as is, and the server's refusal names the limit. */
export async function fitImage(file: File): Promise<File> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return file;
	}
	const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
	if (scale === 1 && file.size <= MAX_ATTACHMENT_BYTES) {
		bitmap.close();
		return file;
	}
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	const ctx = canvas.getContext("2d")!;
	const base = file.name.replace(/\.[^.]*$/, "") || "image";
	// PNG first (screenshot text stays crisp); JPEG on a white ground only
	// when the PNG is still over the cap.
	for (const [type, quality, ext] of [["image/png", undefined, "png"], ["image/jpeg", 0.9, "jpg"], ["image/jpeg", 0.75, "jpg"]] as const) {
		ctx.fillStyle = "#fff";
		if (type === "image/jpeg") ctx.fillRect(0, 0, canvas.width, canvas.height);
		else ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
		if (blob && blob.size <= MAX_ATTACHMENT_BYTES) {
			bitmap.close();
			return new File([blob], `${base}.${ext}`, { type });
		}
	}
	bitmap.close();
	return file;
}

type Intake = { ref?: AttachmentRef; error?: string; refused?: boolean };

/** Read a JSON refusal off a failed response. */
async function refusalOf(res: Response | null): Promise<Intake> {
	const json = (await res?.json().catch(() => ({}))) as { error?: string; code?: string } | undefined;
	return { error: json?.error ?? "The image could not be attached.", refused: json?.code === IMAGES_UNSUPPORTED_CODE };
}

/** The composer-side state for one chat (or the new-session draft, with
 *  no chatId): pending refs, the notice line, and the intake paths. Every
 *  intake names the chat, so the server refuses images the chat's model
 *  can't read and the refusal becomes the notice. */
export function useAttachments(chatId?: string) {
	const [items, setItems] = useState<AttachmentRef[]>([]);
	const [notice, setNotice] = useState<string | null>(null);

	/** Fit one image and upload it; the ref, or the server's refusal. */
	const upload = useCallback(
		async (file: File): Promise<Intake> => {
			const form = new FormData();
			if (chatId) form.append("chatId", chatId);
			const fitted = await fitImage(file);
			form.append("file", fitted, fitted.name);
			const res = await fetch("/api/attachments", { method: "POST", body: form }).catch(() => null);
			if (!res?.ok) return refusalOf(res);
			return { ref: ((await res.json()) as { attachment: AttachmentRef }).attachment };
		},
		[chatId],
	);

	const addFiles = useCallback(
		async (files: File[]) => {
			setNotice(null);
			for (const file of files) {
				const { ref, error } = await upload(file);
				if (ref) setItems((prev) => (prev.some((p) => p.id === ref.id) ? prev : [...prev, ref]));
				else setNotice(error!);
			}
		},
		[upload],
	);

	/** Lift every image path in `text` into the store: attached paths leave
	 *  the text (the stored copy replaces them); paths that fail stay as
	 *  typed. Returns the text to send and the refs to send with it. */
	const takePaths = useCallback(
		async (text: string): Promise<{ text: string; refs: AttachmentRef[] }> => {
			const refs = [...items];
			let out = text;
			for (const hit of findImagePaths(text).reverse()) {
				const res = await fetch("/api/attachments/file", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: hit.path, ...(chatId ? { chatId } : {}) }),
				}).catch(() => null);
				const { ref, error, refused } = res?.ok
					? await upload(new File([await res.blob()], hit.path.replace(/\\ /g, " ").split("/").pop()!, { type: res.headers.get("Content-Type") ?? "" }))
					: await refusalOf(res);
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
		[items, chatId, upload],
	);

	const remove = useCallback((id: string) => setItems((prev) => prev.filter((p) => p.id !== id)), []);
	const clear = useCallback(() => setItems([]), []);
	/** Put refs back (a refused send's draft restore). */
	const restore = useCallback((refs: AttachmentRef[]) => setItems(refs), []);

	return { items, notice, addFiles, takePaths, remove, clear, restore };
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

/** The composer's notice line (a refusal, or a path sent as text). */
export function AttachmentNotice({ notice }: { notice: string | null }) {
	if (!notice) return null;
	return (
		<div data-testid="attachment-notice" className="px-3 pt-2 font-ui text-xs text-muted-foreground">
			{notice}
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
