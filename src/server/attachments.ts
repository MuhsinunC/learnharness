/**
 * Image-attachment gates (LH-39): the server half of the "never a silent
 * failure" rule. A send carrying images to a model that cannot take them
 * refuses with IMAGES_UNSUPPORTED_CODE before anything is persisted; the
 * composer already shows the same message at attach time.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { IMAGES_UNSUPPORTED_CODE, imagesUnsupportedText, supportsImages, type AttachmentRef } from "../core/attachments.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { attachmentExists } from "../store/attachments.ts";
import { effectiveSettings, stores } from "./stores.ts";

export { AttachmentError, saveAttachment, saveAttachmentFromPath, readAttachment } from "../store/attachments.ts";

/** The engine with its Model's `input` matching the effective setting —
 *  pi-ai drops image blocks for a model whose input lacks "image", so an
 *  override must reach the Model object itself. */
export function withImageSupport(engine: PiEngine): PiEngine {
	const images = supportsImages(engine.model, effectiveSettings().imageSupport);
	if (images === engine.model.input.includes("image")) return engine;
	const input: Model<Api>["input"] = images ? [...engine.model.input, "image"] : engine.model.input.filter((m) => m !== "image");
	return { ...engine, model: { ...engine.model, input } };
}

/** 400 when the attachments can't go to this model (or an id is not in
 *  the store); null when the send may proceed. */
export function imageInputRefusal(model: Model<Api>, attachments: readonly AttachmentRef[] | undefined): Response | null {
	if (!attachments?.length) return null;
	const missing = attachments.find((a) => !attachmentExists(a.id));
	if (missing) return Response.json({ error: `No stored image has the id ${missing.id}.` }, { status: 400 });
	if (supportsImages(model, effectiveSettings().imageSupport)) return null;
	return Response.json({ error: imagesUnsupportedText(model), code: IMAGES_UNSUPPORTED_CODE }, { status: 400 });
}

/** The same gate for a chat by id (the steer route has no engine). */
export function chatImageRefusal(chatId: string, attachments: readonly AttachmentRef[] | undefined): Response | null {
	if (!attachments?.length) return null;
	const spec = resolveConversationSpec(stores.chatStore.getChat(chatId)?.settings, effectiveSettings().models.strong);
	let model: Model<Api> | undefined;
	try { model = spec ? piEngineForSpec(spec).model : undefined; }
	catch { model = undefined; }
	if (!model) return Response.json({ error: "The selected model is unavailable." }, { status: 503 });
	return imageInputRefusal(model, attachments);
}
