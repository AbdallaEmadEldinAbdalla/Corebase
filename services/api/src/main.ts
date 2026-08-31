import { buildApp } from './app.ts';

const port = Number(process.env.PORT ?? 8080);
const app = buildApp({ logger: true });
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
