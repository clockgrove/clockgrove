// #401: a journey failure, a timeout included, names the step it stopped in. `onFailed` is Vitest's
// `onTestFailed`; it runs after the test body, its cleanup included, has finished.
export function namedSteps(onFailed) {
  const at = { step: "start" };
  onFailed(({ task }) => {
    for (const error of task.result?.errors ?? [])
      error.message = `step "${at.step}": ${error.message}`;
  });
  return at;
}

// Runs the journey, then its shutdown. The shutdown step is named only once every journey step has
// passed, so a failure inside the journey keeps the step it failed in, and a shutdown that fails
// after it adds to that error instead of replacing it.
export async function journeyThenShutdown(at, journey, shutdownStep, shutdown) {
  try {
    await journey();
  } catch (error) {
    await shutdown().catch((failed) => {
      error.message += `\nshutdown also failed: ${failed?.message ?? failed}`;
    });
    throw error;
  }
  at.step = shutdownStep;
  await shutdown();
}
