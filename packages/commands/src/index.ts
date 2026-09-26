// @tiehall/commands: execute() and one handler per command definition; everything that touches the database, the queue or the network.
export { type AppendedEvent } from "./append-event.ts";
export {
  catalogSurfaceOf,
  provenanceOf,
  type AgentSurface,
  type Caller,
  type CallerKind,
  type CiCaller,
  type IntegrationEventCaller,
  type OAuthTokenCaller,
  type PersonalAccessTokenCaller,
  type SystemJobCaller,
  type UserCaller,
  type WebSessionCaller,
} from "./caller.ts";
export {
  createExecute,
  defineHandler,
  OutputSchemaError,
  type ConfirmationClaim,
  type Confirmations,
  type Execute,
  type ExecuteOptions,
  type ExecuteServices,
  type Handler,
  type HandlerContext,
  type Handlers,
} from "./execute.ts";
export {
  INTEGRATION_SECRETS,
  readSecret,
  storeSecret,
  type IntegrationSecret,
} from "./integration-secrets.ts";
export {
  emailStatus,
  installLink,
  openMailer,
  requestKey,
  sendTestMessage,
  SMTP_TIMEOUT_MS,
  TEST_MESSAGE,
  type EmailStatus,
  type EmailTemplate,
  type Mailer,
  type MailerOptions,
  type ServerText,
  type TemplateValues,
} from "./email.ts";
export {
  IDEMPOTENCY_KEY_HOURS,
  idempotencyCallerOf,
  IdempotentReplay,
  parseIdempotencyKey,
  pruneIdempotencyKeys,
  requestDigest,
  runOnce,
  type IdempotencyClaim,
  type StoredResponse,
} from "./idempotency.ts";
export { HEALTH_TIMEOUT_MS, openDatabaseHealth, type DatabaseHealth, type DatabaseHealthOptions, type Health } from "./health.ts";
export { installJobQueue, JOB_QUEUE_VERSION, openJobQueue, type JobQueue, type JobQueueOptions } from "./job-queue.ts";
export {
  defineJobType,
  JobTypeError,
  type DefinedJobType,
  type JobData,
  type JobSender,
  type JobSettings,
  type JobType,
} from "./jobs.ts";
export { createLogger, LOGGABLE, REDACTED, scrub, type LogEntry, type LogFields, type Logger, type LoggerOptions, type LogLevel } from "./log.ts";
export { migrate, type AppRole, type DatabaseConnection, type MigrateOptions } from "./migrations.ts";
export { openDatabase, type Database } from "./database.ts";
export { HANDLERS } from "./handlers.ts";
export { createRestHandler, type RestHandler, type RestOptions } from "./rest.ts";
export { takeEventNumber } from "./event-sequence.ts";
export {
  openSecretBox,
  SECRET_KEY_MIN_LENGTH,
  SecretKeyError,
  secretKeyProblem,
  type Sealed,
  type SecretBox,
} from "./secret-box.ts";
export {
  BUNDLED_APP_DATABASE_URL,
  BUNDLED_OWNER_DATABASE_URL,
  installUrl,
  readAppDatabase,
  readAppSettings,
  readMigrateSettings,
  SETTINGS,
  SettingsError,
  type AppSettings,
  type Environment,
  type MigrateSettings,
  type SettingDefinition,
  type SettingInit,
  type SmtpSettings,
  type SmtpTls,
} from "./settings.ts";
export { SetupRequiredError, withOrg, type OrgContext } from "./with-org.ts";
export { ORIGIN_RETENTION_DAYS, pruneSecurityEventOrigins } from "./security-event-origins.ts";
export {
  DEFAULT_STOP_TIMEOUT_MS,
  startWorker,
  type RunningJob,
  type Worker,
  type WorkerJob,
  type WorkerOptions,
  type WorkerServices,
} from "./worker.ts";
export { WORKER_JOBS } from "./worker-jobs.ts";
export {
  USER_AGENT_MAX_LENGTH,
  write,
  writeIn,
  WriteWithoutEventError,
  type Origin,
  type Store,
  type WriteOptions,
  type Writer,
} from "./write.ts";
