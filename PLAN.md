# Regulon — Plan de entrenamiento

Clasificador de norma ENACOM aplicable a un producto de RF.

## Arquitectura

Dos vías en paralelo, conviven en producción:

1. **Clasificador fine-tuneado** (rápido, output directo).
2. **RAG sobre documentos ENACOM** (verificación + justificación).

PDF de ENACOM = **base, no source of truth**. Se usa para alimentar una tabla estructurada (`{norma, banda_min, banda_max, potencia_max, modulación, uso, ...}`) que sí es source of truth en runtime. El LLM nunca infiere rangos numéricos: los lee de la tabla.

## Pipeline conceptual

1. Extracción estructurada del PDF → tabla de normas (determinística, revisión humana).
2. Clasificador: input = specs del producto, output = norma. *Matchea* contra la tabla, no inventa rangos.
3. RAG: contexto narrativo, excepciones, justificación, resoluciones modificatorias.

## Stack de fine-tune

- **Modelo base**: Qwen3 (7-8B).
- **Método**: LoRA / QLoRA.
- **Framework**: Unsloth.
- **Hardware**: RTX 5070 local.
- **Dataset target**: 200-500 ejemplos para señal inicial, 1k-5k para algo serio. Split 70/15/15. Incluir casos borde / negativos.
- **Formato**: JSONL con pares `input (specs JSON) → output (norma + justificación)`.
- **Métricas**: accuracy de norma, F1 por clase.

## Stack de RAG (a definir después)

- Chunking del PDF + resoluciones relacionadas.
- Embeddings multilingües (`bge-m3` / `multilingual-e5-large`).
- Vector store: Qdrant / Chroma / pgvector.
- Retriever híbrido BM25 + denso (BM25 ayuda con rangos numéricos).
- Re-ranker opcional (`bge-reranker-v2-m3`).

## Orden de trabajo

1. **Modelo de datos** ← acá estamos.
2. Llenado del modelo (manual / scraping ENACOM / extracción PDF).
3. RAG end-to-end con 1 producto de prueba (baseline).
4. Dataset etiquetado de homologaciones reales.
5. LoRA del clasificador y comparación vs RAG.
