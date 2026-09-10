/**
 * Admin pages: overview & history, the composer with a live preview of the
 * real email, subscribers, and settings (including the HTML template, also
 * with a live preview).
 *
 * Every render of an email goes through the server's `preview` route rather
 * than a client-side approximation, so what you see is byte-for-byte what a
 * recipient gets — same template, same Portable Text renderer, same merge.
 */
import { Badge, Button, Input } from "@cloudflare/kumo";
import { PortableTextEditor } from "@emdash-cms/admin";
import type { PluginAdminExports } from "emdash";
import { apiFetch as baseFetch } from "emdash/plugin-utils";
import * as React from "react";

const API = "/_emdash/api/plugins/emdash-mailing-list";

type PTBlocks = Array<Record<string, unknown>>;

async function call<T = unknown>(route: string, body?: unknown): Promise<T> {
	const response = await baseFetch(`${API}/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	const payload = (await response.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string } };
	if (!response.ok || payload.success === false) throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
	return payload.data as T;
}

function ago(iso: string | null | undefined): string {
	if (!iso) return "never";
	const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
	return new Date(iso).toLocaleDateString();
}

function useDebounced<T>(value: T, ms: number): T {
	const [debounced, setDebounced] = React.useState(value);
	React.useEffect(() => {
		const t = setTimeout(() => setDebounced(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return debounced;
}

function Notice({ kind, children }: { kind: "error" | "success" | "info"; children: React.ReactNode }) {
	const tone =
		kind === "error"
			? "border-red-300 bg-red-50 text-red-800"
			: kind === "success"
				? "border-green-300 bg-green-50 text-green-800"
				: "border-blue-300 bg-blue-50 text-blue-900";
	return <div className={`rounded border p-3 text-sm ${tone}`}>{children}</div>;
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
	return (
		<div className="rounded border p-3">
			<div className="text-xs uppercase tracking-wide text-kumo-subtle">{label}</div>
			<div className="text-lg font-semibold">{value}</div>
			{hint && <div className="text-xs text-kumo-subtle">{hint}</div>}
		</div>
	);
}

/** The email as a recipient would see it: an isolated document, no scripts. */
function EmailFrame({ html, height = 640 }: { html: string; height?: number }) {
	return (
		<iframe
			title="Email preview"
			srcDoc={html}
			sandbox=""
			className="w-full rounded border bg-white"
			style={{ height }}
		/>
	);
}

// ─── Overview ────────────────────────────────────────────────────────────────

interface BlastSummary {
	id: string;
	subject: string;
	status: "sending" | "sent";
	total: number;
	sent: number;
	delivered: number;
	failed: number;
	bounced: number;
	opened: number;
	clicked: number;
	delayed: number;
	held: number;
	openRate: number | null;
	clickRate: number | null;
	createdAt: string;
	completedAt: string | null;
}

interface Overview {
	available: boolean;
	collection: string;
	counts: { confirmed: number; pending: number; blocked: number; unsubscribed: number; total: number };
	extraSources: Array<{ collection: string; total: number }>;
	extraTotal: number;
	blasts: BlastSummary[];
	health: { status: string; checks: Record<string, unknown> };
}

function OverviewPage() {
	const [data, setData] = React.useState<Overview | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [detail, setDetail] = React.useState<{ blast: BlastSummary; html: string; failures: Array<{ email: string; status: string; error: string }> } | null>(null);

	const refresh = React.useCallback(async () => {
		try {
			setData(await call<Overview>("overview"));
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);
	React.useEffect(() => {
		void refresh();
		const t = setInterval(() => void refresh(), 30_000);
		return () => clearInterval(t);
	}, [refresh]);

	const openDetail = async (id: string) => {
		try {
			setDetail(await call("blast", { id }));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div className="space-y-6 p-6">
			<div>
				<h1 className="text-xl font-semibold">Mailing List</h1>
				<p className="mt-1 text-sm text-kumo-subtle">
					Subscribers live in the <code>{data?.collection ?? "subscribers"}</code> collection under Content. Compose a blast from the Compose page.
				</p>
			</div>
			{error && <Notice kind="error">{error}</Notice>}
			{data && !data.available && (
				<Notice kind="error">
					The <code>{data.collection}</code> collection doesn't exist. Create it (fields: email, subscription, blocked, token, soft_fails, bounce_reason, source) or change the source collections in Settings.
				</Notice>
			)}
			{data && (
				<>
					<div className="grid grid-cols-2 gap-3 md:grid-cols-5">
						<Stat label="Sendable" value={data.counts.confirmed} hint={data.extraTotal ? `+${data.extraTotal} in other sources` : undefined} />
						<Stat label="Pending" value={data.counts.pending} hint="awaiting confirmation" />
						<Stat label="Blocked" value={data.counts.blocked} hint="bounced or suppressed" />
						<Stat label="Unsubscribed" value={data.counts.unsubscribed} />
						<Stat
							label="Health"
							value={data.health.status === "healthy" ? "Healthy" : "Degraded"}
							hint={`queue ${String(data.health.checks.cron)} · provider ${String(data.health.checks.email_provider)}`}
						/>
					</div>

					<section className="space-y-2">
						<h2 className="font-medium">Blasts</h2>
						<p className="text-xs text-kumo-subtle">
							Opens and clicks are unique recipients as a share of delivered. They come from Postal webhooks, and open tracking always undercounts — many clients block the pixel.
						</p>
						{data.blasts.length === 0 ? (
							<p className="text-sm text-kumo-subtle">No blasts sent yet.</p>
						) : (
							<div className="overflow-x-auto rounded border">
								<table className="w-full text-sm">
									<thead className="bg-kumo-tint text-left text-xs uppercase tracking-wide text-kumo-subtle">
										<tr>
											<th className="p-2">Subject</th>
											<th className="p-2">Status</th>
											<th className="p-2">Sent</th>
											<th className="p-2">Delivered</th>
											<th className="p-2">Opened</th>
											<th className="p-2">Clicked</th>
											<th className="p-2">Failed / bounced</th>
											<th className="p-2">When</th>
										</tr>
									</thead>
									<tbody>
										{data.blasts.map((b) => (
											<tr key={b.id} className="cursor-pointer border-t hover:bg-kumo-tint" onClick={() => void openDetail(b.id)}>
												<td className="p-2 font-medium">{b.subject}</td>
												<td className="p-2"><Badge variant={b.status === "sent" ? "success" : "neutral"}>{b.status}</Badge></td>
												<td className="p-2">{b.sent}/{b.total}</td>
												<td className="p-2">{b.delivered}</td>
												<td className="p-2">{b.opened}{b.openRate !== null ? ` (${b.openRate}%)` : ""}</td>
												<td className="p-2">{b.clicked}{b.clickRate !== null ? ` (${b.clickRate}%)` : ""}</td>
												<td className="p-2">{b.failed} / {b.bounced}{b.delayed + b.held ? ` (${b.delayed + b.held} delayed)` : ""}</td>
												<td className="p-2 text-kumo-subtle">{ago(b.createdAt)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</section>

					{detail && (
						<section className="space-y-3 rounded border p-4">
							<div className="flex items-center justify-between">
								<h2 className="font-medium">{detail.blast.subject}</h2>
								<Button variant="ghost" size="sm" onClick={() => setDetail(null)}>Close</Button>
							</div>
							{detail.failures.length > 0 && (
								<div className="text-sm">
									<div className="mb-1 font-medium">Problems ({detail.failures.length})</div>
									<ul className="max-h-48 space-y-1 overflow-auto">
										{detail.failures.map((f) => (
											<li key={f.email} className="text-kumo-subtle">
												{f.email} — {f.status}{f.error ? `: ${f.error}` : ""}
											</li>
										))}
									</ul>
								</div>
							)}
							<EmailFrame html={detail.html} height={520} />
						</section>
					)}
				</>
			)}
		</div>
	);
}

// ─── Compose ─────────────────────────────────────────────────────────────────

interface SourceOption {
	collection: string;
	field: string | null;
	values: Array<{ value: string; count: number }>;
	total: number;
}

interface ComposeOptions {
	listName: string;
	primary: string;
	sources: SourceOption[];
	sampleEmails: string[];
}

interface Targets {
	includePrimary: boolean;
	sources: Record<string, { include: boolean; values?: string[] }>;
	advanced?: string;
}

function ComposePage() {
	const [options, setOptions] = React.useState<ComposeOptions | null>(null);
	const [subject, setSubject] = React.useState("");
	const [bodyPT, setBodyPT] = React.useState<PTBlocks>([]);
	const [targets, setTargets] = React.useState<Targets>({ includePrimary: true, sources: {}, advanced: "" });
	const [sampleEmail, setSampleEmail] = React.useState("");
	const [preview, setPreview] = React.useState<{ html: string; text: string; subject: string } | null>(null);
	const [previewError, setPreviewError] = React.useState<string | null>(null);
	const [mode, setMode] = React.useState<"html" | "text">("html");
	const [evaluation, setEvaluation] = React.useState<{ total: number; recipients: Array<{ email: string; source: string; state: string }>; filtersRaw: string } | null>(null);
	const [testTo, setTestTo] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [notice, setNotice] = React.useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);

	React.useEffect(() => {
		call<ComposeOptions>("compose-options")
			.then((o) => {
				setOptions(o);
				setTargets((t) => ({
					...t,
					sources: Object.fromEntries(o.sources.map((s) => [s.collection, { include: true, values: s.values.map((v) => v.value) }])),
				}));
				if (o.sampleEmails[0]) setSampleEmail(o.sampleEmails[0]);
			})
			.catch((e) => setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) }));
	}, []);

	// Live preview: rendered on the server, debounced so typing doesn't hammer it.
	const draft = useDebounced({ subject, bodyPT, sampleEmail }, 400);
	React.useEffect(() => {
		let cancelled = false;
		call<{ html: string; text: string; subject: string }>("preview", { subject: draft.subject, bodyPT: draft.bodyPT, sampleEmail: draft.sampleEmail || undefined })
			.then((p) => { if (!cancelled) { setPreview(p); setPreviewError(null); } })
			.catch((e) => { if (!cancelled) setPreviewError(e instanceof Error ? e.message : String(e)); });
		return () => { cancelled = true; };
	}, [draft]);

	const content = { subject, bodyPT };
	const hasContent = subject.trim().length > 0 && bodyPT.length > 0;

	const run = async (label: string, fn: () => Promise<unknown>) => {
		setBusy(true);
		setNotice(null);
		try {
			await fn();
			if (label) setNotice({ kind: "success", text: label });
		} catch (e) {
			setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) });
		} finally {
			setBusy(false);
		}
	};

	const toggleSource = (collection: string, include: boolean) =>
		setTargets((t) => ({ ...t, sources: { ...t.sources, [collection]: { ...(t.sources[collection] ?? {}), include } } }));
	const toggleValue = (collection: string, value: string, on: boolean) =>
		setTargets((t) => {
			const current = t.sources[collection]?.values ?? [];
			const values = on ? [...new Set([...current, value])] : current.filter((v) => v !== value);
			return { ...t, sources: { ...t.sources, [collection]: { include: t.sources[collection]?.include ?? true, values } } };
		});

	const doSend = () =>
		run("", async () => {
			const evalResult = await call<{ total: number }>("evaluate", { targets });
			if (evalResult.total === 0) throw new Error("No sendable recipients match that selection");
			if (!window.confirm(`Send “${subject}” to ${evalResult.total} recipient${evalResult.total === 1 ? "" : "s"}?`)) return;
			const result = await call<{ blastId: string; total: number }>("send", { ...content, targets });
			setNotice({ kind: "success", text: `Queued to ${result.total} recipients — sending starts within a minute. Progress is on the Mailing List page.` });
			setSubject("");
			setBodyPT([]);
			setEvaluation(null);
		});

	return (
		<div className="space-y-6 p-6">
			<div>
				<h1 className="text-xl font-semibold">Compose a blast</h1>
				<p className="mt-1 text-sm text-kumo-subtle">
					The preview on the right is the real email — your template, your images, merge tags filled from a real subscriber. Use{" "}
					<code>{"{{email}}"}</code> or any field on the subscriber (or attendee) record as a merge tag.
				</p>
			</div>
			{notice && <Notice kind={notice.kind}>{notice.text}</Notice>}

			<div className="grid gap-6 lg:grid-cols-2">
				<div className="space-y-5">
					<label className="block space-y-1 text-sm">
						<span className="font-medium">Subject</span>
						<Input value={subject} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSubject(e.target.value)} placeholder="BAD DOG returns November 13 🐾" />
					</label>

					<div className="space-y-1 text-sm">
						<span className="font-medium">Message</span>
						<div className="rounded border">
							<PortableTextEditor value={bodyPT as never} onChange={(v) => setBodyPT(v as unknown as PTBlocks)} placeholder="Write the email…" />
						</div>
					</div>

					{options && (
						<section className="space-y-3 rounded border p-4 text-sm">
							<h2 className="font-medium">Send to</h2>
							<label className="flex items-center gap-2">
								<input type="checkbox" checked={targets.includePrimary} onChange={(e) => setTargets((t) => ({ ...t, includePrimary: e.target.checked }))} />
								<span>The <code>{options.primary}</code> list — everyone who signed up and confirmed</span>
							</label>
							{options.sources.map((s) => {
								const pick = targets.sources[s.collection] ?? { include: true, values: s.values.map((v) => v.value) };
								return (
									<div key={s.collection} className="space-y-1">
										<label className="flex items-center gap-2">
											<input type="checkbox" checked={pick.include} onChange={(e) => toggleSource(s.collection, e.target.checked)} />
											<span><code>{s.collection}</code> ({s.total} with an email)</span>
										</label>
										{pick.include && s.field && s.values.length > 0 && (
											<div className="ml-6 grid gap-1 sm:grid-cols-2">
												{s.values.map((v) => (
													<label key={v.value} className="flex items-center gap-2">
														<input type="checkbox" checked={(pick.values ?? []).includes(v.value)} onChange={(e) => toggleValue(s.collection, v.value, e.target.checked)} />
														<span>{s.field} = {v.value} <span className="text-kumo-subtle">({v.count})</span></span>
													</label>
												))}
											</div>
										)}
									</div>
								);
							})}
							<label className="block space-y-1">
								<span className="text-kumo-subtle">Advanced filter (optional) — one line per collection, e.g. <code>attendees: void=false</code></span>
								<textarea
									className="w-full rounded border p-2 font-mono text-xs"
									rows={2}
									value={targets.advanced ?? ""}
									onChange={(e) => setTargets((t) => ({ ...t, advanced: e.target.value }))}
								/>
							</label>
							<div className="flex flex-wrap items-center gap-2">
								<Button variant="secondary" disabled={busy} onClick={() => void run("", async () => setEvaluation(await call("evaluate", { targets })))}>
									Who would get this?
								</Button>
								{evaluation && (
									<span className="text-kumo-subtle">
										{evaluation.total} recipient{evaluation.total === 1 ? "" : "s"}
									</span>
								)}
							</div>
							{evaluation && evaluation.recipients.length > 0 && (
								<ul className="max-h-40 overflow-auto rounded border p-2 text-xs">
									{evaluation.recipients.map((r) => (
										<li key={r.email}>
											{r.email} <span className="text-kumo-subtle">· {r.source} · {r.state === "new" ? "new (will be added)" : r.state}</span>
										</li>
									))}
									{evaluation.total > evaluation.recipients.length && <li className="text-kumo-subtle">…and {evaluation.total - evaluation.recipients.length} more</li>}
								</ul>
							)}
						</section>
					)}

					<section className="space-y-3 rounded border p-4 text-sm">
						<h2 className="font-medium">Send</h2>
						<div className="flex flex-wrap items-center gap-2">
							<Input value={testTo} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTestTo(e.target.value)} placeholder="you@example.com" aria-label="Test recipient" />
							<Button variant="secondary" disabled={busy || !hasContent || !testTo} onClick={() => void run(`Test sent to ${testTo}`, () => call("send-test", { ...content, to: testTo }))}>
								Send a test
							</Button>
						</div>
						<Button disabled={busy || !hasContent} onClick={() => void doSend()}>
							Send the blast
						</Button>
					</section>
				</div>

				<div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
					<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
						<div className="flex items-center gap-2">
							<span className="font-medium">Preview</span>
							<Button size="sm" variant={mode === "html" ? "primary" : "ghost"} onClick={() => setMode("html")}>HTML</Button>
							<Button size="sm" variant={mode === "text" ? "primary" : "ghost"} onClick={() => setMode("text")}>Plain text</Button>
						</div>
						<label className="flex items-center gap-2">
							<span className="text-kumo-subtle">as</span>
							<select className="rounded border p-1" value={sampleEmail} onChange={(e) => setSampleEmail(e.target.value)}>
								<option value="">someone@example.com (placeholder)</option>
								{(options?.sampleEmails ?? []).map((e) => (
									<option key={e} value={e}>{e}</option>
								))}
							</select>
						</label>
					</div>
					{previewError && <Notice kind="error">{previewError}</Notice>}
					{preview && (
						<>
							<div className="rounded border bg-kumo-tint px-3 py-2 text-sm">
								<span className="text-kumo-subtle">Subject:</span> {preview.subject}
							</div>
							{mode === "html" ? (
								<EmailFrame html={preview.html} />
							) : (
								<pre className="max-h-[640px] overflow-auto whitespace-pre-wrap rounded border bg-white p-4 text-xs">{preview.text}</pre>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}

// ─── Subscribers ─────────────────────────────────────────────────────────────

interface SubscriberRow {
	email: string;
	subscription: string;
	blocked: boolean;
	source: string;
	bounceReason: string;
	softFails: number;
}

function SubscribersPage() {
	const [query, setQuery] = React.useState("");
	const [rows, setRows] = React.useState<SubscriberRow[]>([]);
	const [total, setTotal] = React.useState(0);
	const [available, setAvailable] = React.useState(true);
	const [addEmail, setAddEmail] = React.useState("");
	const [notice, setNotice] = React.useState<{ kind: "error" | "success"; text: string } | null>(null);
	const debouncedQuery = useDebounced(query, 300);

	const refresh = React.useCallback(async () => {
		try {
			const r = await call<{ available: boolean; subscribers: SubscriberRow[]; total: number }>("subscribers", { query: debouncedQuery });
			setAvailable(r.available);
			setRows(r.subscribers);
			setTotal(r.total);
		} catch (e) {
			setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) });
		}
	}, [debouncedQuery]);
	React.useEffect(() => { void refresh(); }, [refresh]);

	const act = async (email: string, action: "confirm" | "block" | "unblock" | "delete" | "add") => {
		if (action === "delete" && !window.confirm(`Permanently remove ${email} from the list?`)) return;
		try {
			const r = await call<{ message: string }>("subscriber-action", { email, action });
			setNotice({ kind: "success", text: r.message });
			if (action === "add") setAddEmail("");
			await refresh();
		} catch (e) {
			setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) });
		}
	};

	return (
		<div className="space-y-6 p-6">
			<div>
				<h1 className="text-xl font-semibold">Subscribers</h1>
				<p className="mt-1 text-sm text-kumo-subtle">
					Blocked addresses stay on the list for audit but are never emailed. Unsubscribed addresses are never emailed from any source.
				</p>
			</div>
			{notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
			{!available && <Notice kind="error">The subscribers collection doesn't exist — see Settings.</Notice>}
			<div className="flex flex-wrap items-center gap-2">
				<Input value={query} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} placeholder="Search email, source or state" aria-label="Search subscribers" />
				<span className="text-sm text-kumo-subtle">{total} match{total === 1 ? "" : "es"}</span>
				<span className="grow" />
				<Input value={addEmail} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAddEmail(e.target.value)} placeholder="Add an address as confirmed" aria-label="Add subscriber" />
				<Button variant="secondary" disabled={!addEmail} onClick={() => void act(addEmail, "add")}>Add</Button>
			</div>
			<div className="divide-y rounded border text-sm">
				{rows.length === 0 && <div className="p-3 text-kumo-subtle">Nobody matches.</div>}
				{rows.map((s) => (
					<div key={s.email} className="flex flex-col gap-2 p-3 md:flex-row md:items-center md:justify-between">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-medium">{s.email}</span>
							<Badge variant={s.blocked ? "error" : s.subscription === "confirmed" ? "success" : "neutral"}>{s.blocked ? "blocked" : s.subscription}</Badge>
							{s.source && <span className="text-kumo-subtle">via {s.source}</span>}
							{s.bounceReason && <span className="text-kumo-subtle">({s.bounceReason})</span>}
						</div>
						<div className="flex gap-2">
							{s.subscription === "pending" && <Button size="sm" onClick={() => void act(s.email, "confirm")}>Confirm</Button>}
							{s.blocked ? (
								<Button size="sm" variant="secondary" onClick={() => void act(s.email, "unblock")}>Unblock</Button>
							) : (
								<Button size="sm" variant="secondary" onClick={() => void act(s.email, "block")}>Block</Button>
							)}
							<Button size="sm" variant="ghost" onClick={() => void act(s.email, "delete")}>Delete</Button>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

// ─── Settings ────────────────────────────────────────────────────────────────

interface Settings {
	listName: string;
	batchSize: number;
	contactTo: string;
	collections: string[];
	groupFields: Record<string, string>;
	template: string;
	confirmPath: string;
	unsubscribePath: string;
}

interface SettingsResponse {
	settings: Settings;
	wiring: { subscribeUrl: string; contactUrl: string; webhookUrl: string; healthUrl: string };
}

function SettingsPage() {
	const [form, setForm] = React.useState<{ listName: string; batchSize: string; contactTo: string; collections: string; groupFields: string; template: string; confirmPath: string; unsubscribePath: string } | null>(null);
	const [wiring, setWiring] = React.useState<SettingsResponse["wiring"] | null>(null);
	const [notice, setNotice] = React.useState<{ kind: "error" | "success"; text: string } | null>(null);
	const [preview, setPreview] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState(false);

	React.useEffect(() => {
		call<SettingsResponse>("settings-get")
			.then((r) => {
				setWiring(r.wiring);
				setForm({
					listName: r.settings.listName,
					batchSize: String(r.settings.batchSize),
					contactTo: r.settings.contactTo,
					collections: r.settings.collections.join(", "),
					groupFields: Object.entries(r.settings.groupFields).map(([c, f]) => `${c}:${f}`).join(", "),
					template: r.settings.template,
					confirmPath: r.settings.confirmPath,
					unsubscribePath: r.settings.unsubscribePath,
				});
			})
			.catch((e) => setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) }));
	}, []);

	// Preview of the saved template with a sample message, refreshed after each save.
	const refreshPreview = React.useCallback(async () => {
		try {
			const p = await call<{ html: string }>("preview", {
				subject: "How your template looks",
				body: "## A sample heading\n\nThis is a paragraph inside your template, with **bold**, *italic* and a [link](https://example.com).\n\n- One list item\n- Another",
			});
			setPreview(p.html);
		} catch {
			setPreview(null);
		}
	}, []);
	React.useEffect(() => { void refreshPreview(); }, [refreshPreview]);

	const save = async () => {
		if (!form) return;
		setBusy(true);
		setNotice(null);
		try {
			await call("settings-save", { ...form, batchSize: Number(form.batchSize) });
			setNotice({ kind: "success", text: "Settings saved" });
			await refreshPreview();
		} catch (e) {
			setNotice({ kind: "error", text: e instanceof Error ? e.message : String(e) });
		} finally {
			setBusy(false);
		}
	};

	const field = (key: keyof NonNullable<typeof form>, label: string, hint?: string, props: Record<string, unknown> = {}) =>
		form && (
			<label className="block space-y-1 text-sm">
				<span className="font-medium">{label}</span>
				<Input value={form[key]} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value })} {...props} />
				{hint && <span className="block text-xs text-kumo-subtle">{hint}</span>}
			</label>
		);

	return (
		<div className="space-y-6 p-6">
			<h1 className="text-xl font-semibold">Mailing list settings</h1>
			{notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
			{form && (
				<div className="grid gap-6 lg:grid-cols-2">
					<div className="space-y-4">
						{field("listName", "List name", "Used in emails: “you subscribed to …”")}
						{field("batchSize", "Sends per minute", "1–100", { type: "number" })}
						{field("contactTo", "Contact form recipient", "Blank disables the contact endpoint")}
						{field("collections", "Source collections", "Comma-separated. First is the primary list; extras (attendees, waitlist…) only need an email field.")}
						{field("groupFields", "Checkbox targeting", "collection:field pairs, e.g. attendees:event — each value becomes a checkbox on Compose")}
						{field("confirmPath", "Confirm page path")}
						{field("unsubscribePath", "Unsubscribe page path")}
						<label className="block space-y-1 text-sm">
							<span className="font-medium">HTML email template</span>
							<textarea
								className="w-full rounded border p-2 font-mono text-xs"
								rows={16}
								value={form.template}
								onChange={(e) => setForm({ ...form, template: e.target.value })}
								placeholder="Leave empty for the plain built-in template"
							/>
							<span className="block text-xs text-kumo-subtle">
								<code>{"{{content}}"}</code> receives the message. Also available: <code>{"{{subject}}"}</code>, <code>{"{{unsubscribe_url}}"}</code>, <code>{"{{list_name}}"}</code>.
							</span>
						</label>
						<Button disabled={busy} onClick={() => void save()}>Save settings</Button>

						{wiring && (
							<section className="space-y-2 rounded border p-4 text-sm">
								<h2 className="font-medium">Wiring</h2>
								<p className="text-kumo-subtle">Signup — POST JSON <code>{"{ email, website: \"\" }"}</code>:</p>
								<code className="block break-all rounded bg-kumo-tint p-2 text-xs">{wiring.subscribeUrl}</code>
								<p className="text-kumo-subtle">Postal webhook (enable every event) — treat this URL as a secret:</p>
								<code className="block break-all rounded bg-kumo-tint p-2 text-xs">{wiring.webhookUrl}</code>
								<p className="text-kumo-subtle">Uptime check — keyword “healthy”:</p>
								<code className="block break-all rounded bg-kumo-tint p-2 text-xs">{wiring.healthUrl}</code>
							</section>
						)}
					</div>
					<div className="space-y-2 lg:sticky lg:top-4 lg:self-start">
						<div className="text-sm font-medium">Template preview <span className="font-normal text-kumo-subtle">(as saved)</span></div>
						{preview ? <EmailFrame html={preview} /> : <p className="text-sm text-kumo-subtle">Save to preview.</p>}
					</div>
				</div>
			)}
		</div>
	);
}

export const pages: PluginAdminExports["pages"] = {
	"/": OverviewPage,
	"/compose": ComposePage,
	"/subscribers": SubscribersPage,
	"/settings": SettingsPage,
};
