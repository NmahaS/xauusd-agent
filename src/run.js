import { runPipeline } from './pipeline.js';

runPipeline()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('[run] pipeline fatal error:', err);
    process.exit(2);
  });
