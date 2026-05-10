import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type {
	SQSBatchItemFailure,
	SQSBatchResponse,
	SQSEvent,
} from "aws-lambda";
import { Resource } from "sst";
import { lookup } from "../fcc-lookup.js";

const s3 = new S3Client({});

const SLEEP_MS = 1000;
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			console.warn(
				`[${label}] intento ${attempt}/${MAX_ATTEMPTS} fallo: ${(err as Error).message}`,
			);
			if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
		}
	}
	throw lastErr;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
	const failures: SQSBatchItemFailure[] = [];

	for (const record of event.Records) {
		try {
			const msg = JSON.parse(record.body) as {
				runId: string;
				model: string;
				marca?: string;
				registros?: string;
			};
			const { runId, model, marca, registros } = msg;
			const result = await withRetry(() => lookup(model), model);

			await s3.send(
				new PutObjectCommand({
					Bucket: Resource.FccResults.name,
					Key: `runs/${runId}/${model}.json`,
					Body: JSON.stringify(
						{
							...result,
							marca,
							registros,
							runId,
							fetchedAt: new Date().toISOString(),
						},
						null,
						2,
					),
					ContentType: "application/json",
				}),
			);

			console.log(
				JSON.stringify({
					level: "info",
					event: "message_succeeded",
					runId,
					model,
					marca: marca ?? null,
					fccId: result.fccId,
					ruleParts: result.ruleParts,
					messageId: record.messageId,
				}),
			);

			await sleep(SLEEP_MS);
		} catch (err) {
			let parsed: {
				runId?: string;
				model?: string;
				marca?: string;
			} = {};
			try {
				parsed = JSON.parse(record.body);
			} catch {
				// body no era JSON parseable
			}
			const e = err as Error;
			console.error(
				JSON.stringify({
					level: "error",
					event: "message_failed",
					runId: parsed.runId ?? "unknown",
					model: parsed.model ?? null,
					marca: parsed.marca ?? null,
					messageId: record.messageId,
					receiveCount: Number(
						record.attributes.ApproximateReceiveCount ?? "1",
					),
					error: { name: e?.name, message: e?.message, stack: e?.stack },
				}),
			);
			failures.push({ itemIdentifier: record.messageId });
		}
	}

	return { batchItemFailures: failures };
};
