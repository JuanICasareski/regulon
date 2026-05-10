/**
 * Lee un CSV con columnas (Marca, Modelo, Registros) y encola un mensaje
 * por fila en FccQueue. Todos los mensajes del mismo run comparten runId,
 * por lo que terminan en la misma carpeta de S3: runs/<runId>/<modelo>.json
 *
 * Uso:
 *   pnpm --filter @regulon/data enqueue <ruta-csv>
 *   pnpm --filter @regulon/data enqueue ../../proof.csv
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	SendMessageBatchCommand,
	type SendMessageBatchRequestEntry,
	SQSClient,
} from "@aws-sdk/client-sqs";
import { Resource } from "sst";
import { v7 as uuidv7 } from "uuid";

const sqs = new SQSClient({});

interface Row {
	marca: string;
	modelo: string;
	registros: string;
}

function parseCsv(raw: string): Row[] {
	const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
	if (lines.length < 2) return [];

	const rows: Row[] = [];
	for (const line of lines.slice(1)) {
		const cells = splitCsvLine(line);
		if (cells.length < 3) continue;
		rows.push({
			marca: cells[0].trim(),
			modelo: cells[1].trim(),
			registros: cells[2].trim(),
		});
	}
	return rows;
}

function splitCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') {
			if (inQuotes && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (c === "," && !inQuotes) {
			out.push(cur);
			cur = "";
		} else {
			cur += c;
		}
	}
	out.push(cur);
	return out;
}

async function main(): Promise<number> {
	const csvPath = process.argv[2];
	if (!csvPath) {
		console.error("uso: pnpm --filter @regulon/data enqueue <ruta-csv>");
		return 1;
	}

	const raw = await readFile(resolve(csvPath), "utf8");
	const rows = parseCsv(raw);
	if (!rows.length) {
		console.error("el CSV no tiene filas de datos");
		return 1;
	}

	const runId = uuidv7();
	console.log(`runId: ${runId}`);
	console.log(`encolando ${rows.length} filas...`);

	for (let i = 0; i < rows.length; i += 10) {
		const chunk = rows.slice(i, i + 10);
		const entries: SendMessageBatchRequestEntry[] = chunk.map((row, j) => ({
			Id: `r${i + j}`,
			MessageBody: JSON.stringify({
				runId,
				marca: row.marca,
				model: row.modelo,
				registros: row.registros,
			}),
		}));
		await sqs.send(
			new SendMessageBatchCommand({
				QueueUrl: Resource.FccQueue.url,
				Entries: entries,
			}),
		);
	}

	console.log(`OK. resultados → s3://<bucket>/runs/${runId}/`);
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
