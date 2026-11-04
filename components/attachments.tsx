"use client";

import { useCallback, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { findImagePaths, IMAGES_UNSUPPORTED_CODE, MAX_ATTACHMENT_BYTES, MAX_IMAGE_EDGE, sniffImageExt, type AttachmentRef } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";

/**
 * The composer's image attachments (LH-39). Pasted and dropped images are
 * fitted here — longest edge at most MAX_IMAGE_EDGE, re-encoded under the
 * byte cap, converted when the format is not one the providers take —
 * then uploaded, so the server keeps its own content-addressed copy and
 * the message carries only the reference. Image paths typed or pasted
 * into the text go to POST /api/attachments/file at send time: the server
 * stores an image that already fits, and hands back the bytes of one
 * that doesn't for the same fitting. When the chat's model can't read
 * images, the server refuses the intake (checked once before any
 * decoding) and the composer says so (`notice`) — never a silent drop.
 */

/** Downscale, re-encode or convert an image that is too big in pixels or
 *  bytes, or in a format the server refuses; a png, jpeg, gif or webp
 *  already within both limits uploads byte-for-byte. A JPEG source stays
 *  JPEG; anything else tries PNG (crisp screenshot text, transparency)
 *  and, when it is opaque, JPEG too, and the smaller that fits wins. JPEG
 *  at 0.75 on white is the last resort. What still can't fit uploads as
 *  is, and the server's refusal names the limit. */
export async function fitImage(file: File): Promise<File> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return file;
	}
	const ext = sniffImageExt(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
	const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
	if (ext && scale === 1 && file.size <= MAX_ATTACHMENT_BYTES) {
		bitmap.close();
		return file;
	}
	const canvas = document.createElement("canvas");
	const width = (canvas.width = Math.max(1, Math.round(bitmap.width * scale)));
	const height = (canvas.height = Math.max(1, Math.round(bitmap.height * scale)));
	const ctx = canvas.getContext("2d")!;
	const encode = (type: "image/png" | "image/jpeg", quality?: number) => {
		ctx.clearRect(0, 0, width, height);
		if (type === "image/jpeg") {
			ctx.fillStyle = "#fff"; // JPEG has no alpha
			ctx.fillRect(0, 0, width, height);
		}
		ctx.drawImage(bitmap, 0, 0, width, height);
		return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
	};
	const fits = (blob: Blob | null): blob is Blob => blob !== null && blob.size <= MAX_ATTACHMENT_BYTES;
	/** Reads the canvas as the PNG encode just drew it. */
	const transparent = () => {
		const { data } = ctx.getImageData(0, 0, width, height);
		for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
		return false;
	};
	const png = ext === "jpg" ? null : await encode("image/png");
	const jpeg = ext === "jpg" || !fits(png) || !transparent() ? await encode("image/jpeg", 0.9) : null;
	const best = [png, jpeg].filter(fits).sort((a, b) => a.size - b.size)[0] ?? (await encode("image/jpeg", 0.75));
	bitmap.close();
	if (!fits(best)) return file;
	const base = file.name.replace(/\.[^.]*$/, "") || "image";
	return new File([best], `${base}.${best.type === "image/jpeg" ? "jpg" : "png"}`, { type: best.type });
}

type Intake = { ref?: AttachmentRef; error?: string; refused?: boolean; computerOnly?: boolean };

/** Read a JSON refusal off a failed response. */
async function refusalOf(res: Response | null): Promise<Intake> {
	const json = (await res?.json().catch(() => ({}))) as { error?: string; code?: string; computerOnly?: boolean } | undefined;
	const computerOnly = json?.computerOnly === true;
	return { error: json?.error ?? "The image could not be attached.", refused: computerOnly || json?.code === IMAGES_UNSUPPORTED_CODE, computerOnly };
}

/** The server's refusal of path reads to this browser (a logged-in
 *  session, LH-45), kept so later sends skip the request. One case goes
 *  stale: turning remote access off from this page makes it local, and
 *  paths still go as text until a reload. A model refusal is never kept,
 *  since it changes with the model. */
let pathsRefused: string | null = null;

/** The composer-side state for one chat (or the new-session draft, with
 *  no chatId): pending refs, the notice line, and the intake paths. Every
 *  intake names the chat, so the server refuses images the chat's model
 *  can't read and the refusal becomes the notice. The notice lasts until
 *  the next intake or send, or until the model changes. */
export function useAttachments(chatId?: string) {
	const [items, setItems] = useState<AttachmentRef[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const chatParam = chatId ? `&chatId=${encodeURIComponent(chatId)}` : "";

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
			// The model gate first: a chat that can't take images refuses
			// before any image is decoded or uploaded.
			const check = await fetch(`/api/attachments?check=1${chatParam}`).catch(() => null);
			if (!check?.ok) {
				setNotice((await refusalOf(check)).error!);
				return;
			}
			for (const file of files) {
				const { ref, error } = await upload(file);
				if (ref) setItems((prev) => (prev.some((p) => p.id === ref.id) ? prev : [...prev, ref]));
				else setNotice(error!);
			}
		},
		[upload, chatParam],
	);

	/** One path: stored by the server when it already fits, else its
	 *  bytes come back for the composer to fit and upload. */
	const takePath = useCallback(
		async (raw: string): Promise<Intake> => {
			const res = await fetch("/api/attachments/file", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: raw, ...(chatId ? { chatId } : {}) }),
			}).catch(() => null);
			if (!res?.ok) return refusalOf(res);
			const type = res.headers.get("Content-Type") ?? "";
			if (type.startsWith("application/json")) return { ref: ((await res.json()) as { attachment: AttachmentRef }).attachment };
			return upload(new File([await res.blob()], raw.replace(/\\ /g, " ").split("/").pop()!, { type }));
		},
		[chatId, upload],
	);

	/** Lift every image path in `text` into the store: attached paths leave
	 *  the text (the stored copy replaces them); paths that fail, for any
	 *  reason, stay as typed. Never rejects. Returns the text to send and
	 *  the refs to send with it. */
	const takePaths = useCallback(
		async (text: string): Promise<{ text: string; refs: AttachmentRef[] }> => {
			setNotice(null);
			const refs = [...items];
			const hits = findImagePaths(text);
			if (pathsRefused && hits.length > 0) {
				setNotice(`${pathsRefused} The path was sent as text.`);
				return { text, refs };
			}
			let out = text;
			for (const hit of hits.reverse()) {
				let intake: Intake;
				try {
					intake = await takePath(hit.path);
				} catch {
					continue;
				}
				const { ref, error, refused, computerOnly } = intake;
				if (refused) {
					if (computerOnly) pathsRefused = error!;
					setNotice(`${error} The path was sent as text.`);
					break;
				}
				if (!ref) continue;
				if (!refs.some((r) => r.id === ref.id)) refs.unshift(ref);
				out = out.slice(0, hit.start) + out.slice(hit.end);
			}
			return { text: out === text ? text : out.replace(/[ \t]{2,}/g, " ").trim(), refs };
		},
		[items, takePath],
	);

	// A refusal names a model: another model, a slot change or an image
	// override makes it stale. A chat's own pick reports through
	// modelChanged (it emits no settings signal); the first report is the
	// load, not a change.
	useSettingsSaved((section) => {
		if (section === "models" || section === "imageSupport") setNotice(null);
	});
	const reportedModel = useRef<string | undefined>(undefined);
	const modelChanged = useCallback((model: string | undefined) => {
		if (reportedModel.current !== undefined && model !== reportedModel.current) setNotice(null);
		if (model !== undefined) reportedModel.current = model;
	}, []);

	const remove = useCallback((id: string) => setItems((prev) => prev.filter((p) => p.id !== id)), []);
	const clear = useCallback(() => setItems([]), []);
	/** Put refs back (a refused send's draft restore). */
	const restore = useCallback((refs: AttachmentRef[]) => setItems(refs), []);

	return { items, notice, addFiles, takePaths, remove, clear, restore, showNotice: setNotice, modelChanged };
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
