import type { SagaStep, SagaContext } from './runner.ts';

/**
 * T5b registers the saga SHAPE with no-op steps so the runner, checkpointing
 * and crash-resume can be tested before the Docker work lands. T5c–T5e replace
 * these bodies one at a time; the step names are the checkpoint keys and must
 * not change casually — a rename makes in-flight checkpoints meaningless.
 */
const noop = (name: string): SagaStep<SagaContext> => ({
  name,
  async run(ctx) { ctx.log(`step ${name} (not implemented yet)`); },
});

export const provisionProjectSaga: SagaStep<SagaContext>[] = [
  noop('allocate_node'),        // T5c
  noop('create_volume'),        // T5d
  noop('start_container'),      // T5d
  noop('wait_healthy'),         // T5d
  noop('create_base_roles'),    // T5e
  noop('store_credentials'),    // T5e
  noop('write_connection'),     // T5e
  noop('mark_ready'),           // T5e
];

export const deleteProjectSaga: SagaStep<SagaContext>[] = [
  noop('stop_container'),       // T7
  noop('remove_container'),
  noop('remove_volume'),
  noop('release_capacity'),
  noop('mark_deleted'),
];

export const sagas = {
  provision_project: provisionProjectSaga,
  delete_project: deleteProjectSaga,
};
