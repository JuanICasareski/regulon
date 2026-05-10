/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "regulon-data",
      removal: input?.stage === "prod" ? "retain" : "remove",
      home: "aws",
      providers: { aws: { region: "us-east-1" } },
    };
  },

  async run() {
    const proxyUrl = new sst.Secret("BrightDataProxyUrl");

    // Bucket privado de resultados: results/<MODEL>.json
    const results = new sst.aws.Bucket("FccResults");

    // DLQ: a donde van los mensajes que fallaron 3 veces
    const dlq = new sst.aws.Queue("FccDLQ");

    // Cola principal: cada mensaje es { model: "SM-F700F" }
    const queue = new sst.aws.Queue("FccQueue", {
      visibilityTimeout: "240 seconds",
      dlq: { queue: dlq.arn, retry: 3 },
    });

    // Consumer: scrapea fccid.io y guarda en S3.
    // batch=1 + sleep interno modera el rate. Para serializar al 100%
    // habilitar reservedConcurrentExecutions=1 cuando AWS suba la cuota
    // de Lambda (las cuentas nuevas arrancan en 10 y no permiten reservar).
    queue.subscribe(
      {
        handler: "src/handlers/fcc-consumer.handler",
        link: [results, proxyUrl],
        timeout: "180 seconds",
        memory: "512 MB",
        nodejs: {
          // got-scraping y header-generator cargan JSONs por filesystem;
          // hay que instalarlos en node_modules en vez de bundlearlos.
          install: ["got-scraping", "header-generator"],
        },
      },
      { batch: { size: 1 } },
    );

    return {
      queueUrl: queue.url,
      dlqUrl: dlq.url,
      bucketName: results.name,
    };
  },
});
