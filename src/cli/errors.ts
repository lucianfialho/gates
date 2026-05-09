import { Effect } from "effect";

export interface CliError {
  readonly message: string;
  readonly cause?: unknown;
}

export const renderError = (error: unknown): string => {
  return String(error);
};

export const withCliError = <A>(
  effect: Effect.Effect<A, CliError>
): Effect.Effect<A, CliError> =>
  Effect.catch(effect, (error: CliError) =>
    Effect.sync(() => {
      console.error(renderError(error));
      process.exit(1);
    })
  );