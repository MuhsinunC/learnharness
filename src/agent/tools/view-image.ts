import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { VIEW_IMAGE_TOOL, isAttachmentId } from "../../core/attachments.ts";
import type { AttachmentStore } from "../../core/ports.ts";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";

const viewImageInput = Type.Object({
	id: Type.String({ minLength: 1, description: "The attachment id from the learner's message, e.g. 3f…a9.png" }),
});

/**
 * view_image (LH-39): loads one of the learner's attached images by its
 * store id — never a path, so it reads the attachment store and nothing
 * else. The result itself carries only the id (`details.attachment`);
 * toLlmMessages adds the pixels at the wire, so the record stays
 * reference-only and compaction can drop the image and keep the id.
 */
export function viewImageTool(store: AttachmentStore): AgentTool<typeof viewImageInput> {
	return {
		name: VIEW_IMAGE_TOOL,
		label: VIEW_IMAGE_TOOL,
		description:
			"View an image the learner attached to the conversation, by its attachment id (shown in the learner's message as " +
			"\"Image attached by the learner: <id>\"). Use it when an attached image is not visible to you, for example after " +
			"earlier conversation was summarized. Only attachment ids work; for files on disk use read.",
		parameters: viewImageInput,
		execute: serverExecute(VIEW_IMAGE_TOOL, viewImageInput, ({ id }): ImageFileResult => {
			if (!isAttachmentId(id) || !store.exists(id)) throw new Error(`No attached image has the id ${id}.`);
			return { text: `Attached image ${id}. If no image follows, earlier context was summarized: call ${VIEW_IMAGE_TOOL} again to see it.`, details: { attachment: id } };
		}),
	};
}
