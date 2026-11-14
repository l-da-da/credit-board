// Host half: intentionally empty.
// The data service runs as its own task (DSH-CreditBoard) so it can launch the
// client apps; the DSH host process is not allowed to start GUI processes here.
export function apply() {}