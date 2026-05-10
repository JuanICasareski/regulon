import { gotScraping } from "got-scraping";
import { Resource } from "sst";

export type LookupResult = {
	model: string;
	fccId: string | null;
	ruleParts: string[];
}

async function fetchHtmlOnce(path: string): Promise<string> {
	const proxyUrl = (Resource as { BrightDataProxyUrl?: { value: string } })
		.BrightDataProxyUrl?.value;

	const res = await gotScraping(`https://fccid.io/${path}`, {
		followRedirect: true,
		timeout: { request: 45_000 },
		...(proxyUrl ? { proxyUrl } : {}),
	});
	if (res.statusCode >= 400)
		throw new Error(`HTTP ${res.statusCode} on /${path}`);
	return res.body;
}

async function fetchHtml(path: string, attempts = 3): Promise<string> {
	let lastErr: unknown;
	for (let i = 1; i <= attempts; i++) {
		try {
			return await fetchHtmlOnce(path);
		} catch (err) {
			lastErr = err;
			console.warn(
				`[fetch /${path}] intento ${i}/${attempts} fallo: ${(err as Error).message}`,
			);
			if (i < attempts) {
				await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
			}
		}
	}
	throw lastErr;
}

function extractFccId(html: string, model: string): string | null {
	const flat = model.replace(/-/g, "").toUpperCase();
	const re = new RegExp(`fccid\\.io/([A-Z0-9]{3,5}${flat})\\b`);
	return html.match(re)?.[1] ?? null;
}

function extractRuleParts(html: string): string[] {
	const re =
		/Title-47\/pt47\.\d+\.\d+(?:#sp47\.\d+\.\d+\.[a-z]+)?>([0-9A-Z]+)<\/a>/g;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const [_match, captured_group] of html.matchAll(re)) {
		if (!seen.has(captured_group)) {
			seen.add(captured_group);
			out.push(captured_group);
		}
	}
	return out;
}

export async function lookup(model: string): Promise<LookupResult> {
	const html = await fetchHtml(model);
	const fccId = extractFccId(html, model);
	const ruleParts = extractRuleParts(html);

	if (fccId) {
		try {
			const html2 = await fetchHtml(fccId);
			for (const p of extractRuleParts(html2)) {
				if (!ruleParts.includes(p)) ruleParts.push(p);
			}
		} catch (err) {
			console.error(`(aviso: fallo /${fccId}: ${(err as Error).message})`);
		}
	}

	return { model, fccId, ruleParts };
}
