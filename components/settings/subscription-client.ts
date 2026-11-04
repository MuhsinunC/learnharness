"use client";

import { useMemo } from "react";
import type { ChatGPTControlBridge, ChatGPTStatus, NativeSubscriptionControlBridge, NativeSubscriptionProviderId, NativeSubscriptionStatus } from "@/src/core";
import { useNotifyHub, type createNotifyHub } from "@/components/server-events";

type Hub = ReturnType<typeof createNotifyHub> | null;
type Reply<T> = { value: T; browserAction?: string; error?: string };
const PATH = "/api/subscriptions";
const headers = { "Content-Type": "application/json", "x-learnharness-subscriptions": "1" };

type Statuses = { chatgpt: ChatGPTStatus; native: NativeSubscriptionStatus[] };
/** Which account each subscription is connected with: what the catalog
 *  and the key readers read from a status (LH-54). */
const connectionsOf = (s: Partial<Statuses>) => JSON.stringify([s.chatgpt?.activeId, s.chatgpt?.accounts?.filter((a) => a.connected).map((a) => a.id), Array.isArray(s.native) ? s.native.map((n) => n.connected ? n.connectionId : null) : null]);
/** The connections the window's last status read showed. */
let seenConnections: string | undefined;
async function status() {
	const response = await fetch(PATH, { headers, cache: "no-store" });
	if (!response.ok) throw new Error("Subscription status is unavailable.");
	const value = await response.json() as Statuses;
	seenConnections = connectionsOf(value);
	return value;
}
async function control<T>(providerId: string, op: string, fields: Record<string, unknown> = {}): Promise<Reply<T>> {
	const response = await fetch(PATH, { method: "POST", headers, body: JSON.stringify({ providerId, op, ...fields }) });
	if (!response.ok) throw new Error("The subscription connection could not be changed.");
	return response.json() as Promise<Reply<T>>;
}
/** `compare`: a reconnect re-reads the connections first, and reports a
 *  change (no argument) when they differ from the last read, since the
 *  channel was down when it happened; otherwise "resync" (LH-54). */
function onChange(hub: Hub, listener: (change?: "resync") => void, compare = false): () => void {
	const offEvent = hub?.subscribe("subscriptions-changed", () => listener());
	const offResync = hub?.onResync((reconnect) => {
		const before = seenConnections;
		if (!compare || !reconnect || before === undefined) return listener("resync");
		void status().then(() => listener(seenConnections === before ? "resync" : undefined), () => listener("resync"));
	});
	return () => { offEvent?.(); offResync?.(); };
}
/** Reserve the new tab synchronously in the click gesture. Only a one-use
 * same-origin action URL enters app JS; provider URLs remain in the owner.
 * Electron dev has no tabs: its narrow main-process opener performs this step. */
async function withBrowser<T>(action: () => Promise<Reply<T>>): Promise<T> {
	const external = window.lh?.subscriptionTransport === "web" ? window.lh.openSubscriptionBrowser : undefined;
	const tab = external ? null : window.open("about:blank", "_blank");
	if (!external && !tab) throw new Error("Allow a sign-in tab to open, then try again.");
	if (tab) tab.opener = null;
	try {
		const reply = await action();
		if (reply.browserAction) {
			if (!/^\/api\/subscriptions\/browser\?id=[0-9a-f-]{36}$/.test(reply.browserAction)) throw new Error("Invalid sign-in action.");
			if (external) await external(reply.browserAction);
			else if (tab && !tab.closed) tab.location.href = reply.browserAction;
			else throw new Error("The sign-in tab was closed. Cancel and try again.");
		} else tab?.close();
		return reply.value;
	} catch (error) { tab?.close(); throw error; }
}
export function createWebChatGPTBridge(hub: Hub): ChatGPTControlBridge {
	const call = async (op: string, fields?: Record<string, unknown>) => (await control<ChatGPTStatus>("chatgpt", op, fields)).value;
	return {
		status: async () => (await status()).chatgpt,
		login: (id) => withBrowser(() => control<ChatGPTStatus>("chatgpt", "login", { id })),
		cancel: () => call("cancel"), select: (id) => call("select", { id }),
		disconnect: (id) => call("disconnect", { id }), logout: (id) => call("logout", { id }),
		consent: (enabled) => call("consent", { enabled }),
		onChange: (listener) => onChange(hub, listener),
	};
}
export function createWebNativeBridge(hub: Hub): NativeSubscriptionControlBridge {
	const call = async (providerId: NativeSubscriptionProviderId, op: string, fields?: Record<string, unknown>) => { await control(providerId, op, fields); };
	return {
		status: async () => (await status()).native,
		login: (providerId, enabled) => call(providerId, "login", { enabled }),
		cancel: (providerId) => call(providerId, "cancel"),
		respond: (providerId, attemptId, promptId, value) => call(providerId, "respond", { attemptId, promptId, value }),
		open: async (providerId, attemptId, actionId) => { await withBrowser(() => control(providerId, "open", { attemptId, actionId })); },
		retry: (providerId) => call(providerId, "retry"), disconnect: (providerId) => call(providerId, "disconnect"),
		consent: (providerId, enabled) => call(providerId, "consent", { enabled }),
		onChange: (listener) => onChange(hub, listener, true),
	};
}
export function useChatGPTBridge(): ChatGPTControlBridge | undefined {
	const hub = useNotifyHub();
	return useMemo(() => typeof window === "undefined" ? undefined : window.lh?.subscriptionTransport !== "web" && window.lh?.chatgpt ? window.lh.chatgpt : createWebChatGPTBridge(hub), [hub]);
}
export function useNativeSubscriptionBridge(): NativeSubscriptionControlBridge | undefined {
	const hub = useNotifyHub();
	return useMemo(() => typeof window === "undefined" ? undefined : window.lh?.subscriptionTransport !== "web" && window.lh?.subscriptions ? window.lh.subscriptions : createWebNativeBridge(hub), [hub]);
}
