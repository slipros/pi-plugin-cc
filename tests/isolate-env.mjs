// Preloaded by `npm test` (`node --import`) before any test file runs.
//
// The OTLP exporter reads its target from the environment, and a developer who
// has metrics set up keeps PI_OTEL_ENABLE and PI_OTEL_EXPORTER_OTLP_ENDPOINT in
// the shell. Every test that finishes a tracked job then pushed a real export,
// with the real bearer token, to the developer's collector — one full run sent
// 34 of them — and the otel tests that bring their own collector lost to
// PI_OTEL_EXPORTER_OTLP_ENDPOINT, which outranks the standard OTEL_* they set.
// Clearing the variables here, in the runner process, reaches every test file:
// each runs in a child that inherits this environment. Tests that want the
// exporter on set it themselves.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_OTEL_") || key.startsWith("OTEL_EXPORTER")) delete process.env[key];
}
