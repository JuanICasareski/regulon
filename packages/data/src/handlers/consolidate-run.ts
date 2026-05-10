import {
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { readFile, unlink } from "node:fs/promises";
// @ts-expect-error parquetjs-lite no trae types
import parquet from "parquetjs-lite";
import { Resource } from "sst";

const s3 = new S3Client({});

const CONCURRENCY = 50;

type Event = { runId: string };
type Result = {
	runId: string;
	files: number;
	bytes: number;
	outputKey: string;
};

type Row = {
	model: string;
	fccId: string | null;
	ruleParts: string[];
	marca: string | null;
	registros: string | null;
	runId: string;
	fetchedAt: string;
	notFound: boolean;
	sourceKey: string;
};

const schema = new parquet.ParquetSchema({
	model: { type: "UTF8" },
	fccId: { type: "UTF8", optional: true },
	ruleParts: { type: "UTF8", repeated: true },
	marca: { type: "UTF8", optional: true },
	registros: { type: "UTF8", optional: true },
	runId: { type: "UTF8" },
	fetchedAt: { type: "UTF8" },
	notFound: { type: "BOOLEAN" },
	sourceKey: { type: "UTF8" },
});

async function listAllJsonKeys(
	bucket: string,
	prefix: string,
): Promise<string[]> {
	const keys: string[] = [];
	let token: string | undefined;
	do {
		const res = await s3.send(
			new ListObjectsV2Command({
				Bucket: bucket,
				Prefix: prefix,
				ContinuationToken: token,
			}),
		);
		for (const obj of res.Contents ?? []) {
			if (obj.Key?.endsWith(".json")) keys.push(obj.Key);
		}
		token = res.NextContinuationToken;
	} while (token);
	return keys;
}

async function fetchRow(bucket: string, key: string): Promise<Row> {
	const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	const body = await res.Body!.transformToString();
	const parsed = JSON.parse(body);
	return {
		model: String(parsed.model ?? ""),
		fccId: parsed.fccId ?? null,
		ruleParts: Array.isArray(parsed.ruleParts) ? parsed.ruleParts : [],
		marca: parsed.marca ?? null,
		registros: parsed.registros ?? null,
		runId: String(parsed.runId ?? ""),
		fetchedAt: String(parsed.fetchedAt ?? ""),
		notFound: Boolean(parsed.notFound),
		sourceKey: key,
	};
}

async function mapWithConcurrency<T, U>(
	items: T[],
	limit: number,
	fn: (item: T, idx: number) => Promise<U>,
): Promise<U[]> {
	const out: U[] = new Array(items.length);
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const i = cursor++;
				if (i >= items.length) return;
				out[i] = await fn(items[i], i);
			}
		},
	);
	await Promise.all(workers);
	return out;
}

export const handler = async (event: Event): Promise<Result> => {
	const { runId } = event;
	if (!runId) throw new Error("missing runId in event payload");

	const bucket = Resource.FccResults.name;
	const prefix = `runs/${runId}/`;
	const outputKey = `${prefix}_consolidated.parquet`;
	const tmpPath = `/tmp/${runId}.parquet`;

	console.log(JSON.stringify({ event: "consolidate_start", runId, prefix }));

	const allKeys = await listAllJsonKeys(bucket, prefix);
	const keys = allKeys.filter((k) => !k.endsWith("/_consolidated.parquet"));
	console.log(JSON.stringify({ event: "listed", runId, count: keys.length }));

	if (keys.length === 0) {
		throw new Error(`no JSON files found under s3://${bucket}/${prefix}`);
	}

	const rows = await mapWithConcurrency(keys, CONCURRENCY, (key) =>
		fetchRow(bucket, key),
	);

	const writer = await parquet.ParquetWriter.openFile(schema, tmpPath, {
		compression: "SNAPPY",
	});
	for (const row of rows) await writer.appendRow(row);
	await writer.close();

	const body = await readFile(tmpPath);
	await s3.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: outputKey,
			Body: body,
			ContentType: "application/vnd.apache.parquet",
		}),
	);
	await unlink(tmpPath).catch(() => {});

	const result: Result = {
		runId,
		files: keys.length,
		bytes: body.byteLength,
		outputKey,
	};
	console.log(JSON.stringify({ event: "consolidate_done", ...result }));
	return result;
};
