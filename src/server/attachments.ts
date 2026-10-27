/**
 * Image-attachment gates (LH-39): the server half of the "never a silent
 * failure" rule. An intake for a chat whose model can't read images, and
 * a send carrying images to such a model, refuse with
 * IMAGES_UNSUPPORTED_CODE before anything is stored or persisted; the
 * composer shows the refusal as its notice.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { IMAGES_UNSUPPORTED_CODE, imagesUnsupportedText, supportsImages, type AttachmentRef } from "../core/attachments.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { attachmentExists } from "../store/attachments.ts";
import { effectiveSettings, stores } from "./stores.ts";

export { AttachmentError, saveAttachment, readAttachment, readImageFile } from "../store/attachments.ts";

/** The engine with its Model's `input` matching the effective setting —
 *  pi-ai drops image blocks for a model whose input lacks "image", so an
 *  override must reach the Model object itself. */
export function withImageSupport(engine: PiEngine): PiEngine {
	const images = supportsImages(engine.model, effectiveSettings().imageSupport);
	if (images === engine.model.input.includes("image")) return engine;
	const input: Model<Api>["input"] = images ? [...engine.model.input, "image"] : engine.model.input.filter((m) => m !== "image");
	return { ...engine, model: { ...engine.model, input } };
}

/** 400 when this model can't read images (the override counted). */
function modelRefusal(model: Model<Api>): Response | null {
	if (supportsImages(model, effectiveSettings().imageSupport)) return null;
	return Response.json({ error: imagesUnsupportedText(model), code: IMAGES_UNSUPPORTED_CODE }, { status: 400 });
}

/** 400 when the attachments can't go to this model (or an id is not in
 *  the store); null when the send may proceed. */
export function imageInputRefusal(model: Model<Api>, attachments: readonly AttachmentRef[] | undefined): Response | null {
	if (!attachments?.length) return null;
	const missing = attachments.find((a) => !attachmentExists(a.id));
	if (missing) return Response.json({ error: `No stored image has the id ${missing.id}.` }, { status: 400 });
	return modelRefusal(model);
}

/** The model a chat's next turn would run (no engine exists yet), or the
 *  503 when it doesn't resolve. No chat id = the new-session draft, which
 *  the server will stamp from the strong slot. */
function chatModel(chatId: string | undefined): Model<Api> | Response {
	const settings = chatId ? stores.chatStore.getChat(chatId)?.settings : undefined;
	const spec = resolveConversationSpec(settings, effectiveSettings().models.strong);
	try {
		const model = spec ? piEngineForSpec(spec).model : undefined;
		if (model) return model;
	} catch { /* the 503 below */ }
	return Response.json({ error: "The selected model is unavailable." }, { status: 503 });
}

/** The intake gate: may this chat take images at all? */
export function chatIntakeRefusal(chatId: string | undefined): Response | null {
	const model = chatModel(chatId);
	return model instanceof Response ? model : modelRefusal(model);
}

/** The send gate for a chat by id (the steer route has no engine): null
 *  when nothing is attached, before any model resolves. */
export function chatAttachmentRefusal(chatId: string, attachments: readonly AttachmentRef[] | undefined): Response | null {
	if (!attachments?.length) return null;
	const model = chatModel(chatId);
	return model instanceof Response ? model : imageInputRefusal(model, attachments);
}
