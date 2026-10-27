import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { parseAttachmentRefs, slotsConfigured } from "@/src/core";
import { compactionInFlight, getChat, isTurnRunning, readSettingsRecord, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string; images?: string }>;
}) {
	const [{ id }, { prompt, images }] = await Promise.all([params, searchParams]);
	const chat = getChat(id);
	if (!chat) notFound();
	// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
	// over the settings record, server-read — the same gate home/new read. The
	// server's 503 stays the truth; this only decides whether the pill rides.
	const record = readSettingsRecord();
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			// Wave D: the record IS native agent history — the client view is
				// derived app-side (core/view.ts projectView; GET serves the same
				// native messages).
				initialMessages={chat.messages}
			initialError={turnFailure(chat.id)}
			initialConfigured={slotsConfigured(record?.models)}
			initialPrompt={prompt}
			// New-session images (LH-39): stored ids only — anything else drops.
			initialAttachments={parseAttachmentRefs(images?.split(",").map((imageId) => ({ id: imageId }))) ?? undefined}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={isTurnRunning(chat.id)}
			initiallyCompacting={compactionInFlight(chat.id)}
		/>
	);
}
