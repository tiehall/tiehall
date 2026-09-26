// @tiehall/commands: execute() and one handler per command definition; everything that touches the database, the queue or the network.
export { type AppendedEvent } from "./append-event.ts";
export {
  actsForUser,
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
  actingFor,
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
export { createLogger, LOGGABLE, REDACTED, routeConsoleTo, scrub, type LogEntry, type LogFields, type Logger, type LoggerOptions, type LogLevel } from "./log.ts";
export { assertRoleAllows, memberOf, teamsOfMember, type Member, type MemberTeam } from "./members.ts";
export { migrate, type AppRole, type DatabaseConnection, type MigrateOptions } from "./migrations.ts";
export { openDatabase, type Database } from "./database.ts";
export { HANDLERS } from "./handlers.ts";
export { noticeOfEvent, type NoticeEvent } from "./notices.ts";
export {
  createGitHubFetch,
  createJiraFetch,
  createOutboundFetcher,
  GITHUB_ORIGINS,
  isPublicAddress,
  OutboundRefused,
  type ConnectTarget,
  type Fetch,
  type FetchedDocument,
  type OutboundFetcher,
  type OutboundFetcherOptions,
  type OutboundRefusalReason,
} from "./outbound.ts";
export { createRestHandler, type RestHandler, type RestOptions } from "./rest.ts";
export { PACKET_SCHEMA_PATH, packetSchemaRoute } from "./packet-schema-route.ts";
export { packetRevisionOf, storePacketRevision, type PacketRevisionView } from "./packet-revisions.ts";
export { takeEventNumber } from "./event-sequence.ts";
export { readerOf } from "./event-reads.ts";
export { takeRequestNumber } from "./request-numbers.ts";
export { noSuchRequest, resolveRequestKey, teamOfKey, type ResolvedRequestKey } from "./request-keys.ts";
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
  readAuthSecret,
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
export { RemovedMemberError, SetupRequiredError, withOrg, type OrgContext, type WithOrgOptions } from "./with-org.ts";
export {
  createSetupGate,
  readSetupState,
  SETUP_PATH,
  setupGateAnswer,
  WEBHOOKS_GITHUB_PATH,
  type SetupGate,
  type SetupGateAnswer,
  type SetupGateOptions,
  type SetupState,
} from "./setup-gate.ts";
export {
  generateSetupCode,
  isSetupSession,
  normalizeSetupCode,
  openSetupSession,
  SETUP_CODE_BITS,
  SETUP_CODE_LENGTH,
  startSetup,
  type StartSetupOptions,
} from "./setup-code.ts";
export { createSetupRoute, setupCookieName, type SetupRoute, type SetupRouteOptions } from "./setup-route.ts";
export {
  createConfirmationStep,
  type ConfirmationStep,
  type ConfirmationStepServices,
  type ConfirmationSubjects,
  type ReviewContext,
  type ReviewedAction,
  type ReviewHandler,
  type Reviews,
} from "./confirmation-step.ts";
export { CONFIRM_PATH, CONFIRM_ROUTE_PATHS, createConfirmRoute, type ConfirmDownloads, type ConfirmRoute, type ConfirmRouteOptions, type Download } from "./confirm-route.ts";
export { ACTIVITY_LOG_PATH, createActivityLogRoute, type ActivityLogRoute, type ActivityLogRouteOptions } from "./activity-log-route.ts";
export {
  actionDigest,
  checkConfirmationNonce,
  CONFIRMATION_NONCE_BYTES,
  CONFIRMATION_NONCE_TTL_SECONDS,
  issueConfirmationNonce,
  type CheckedNonce,
  type NonceBinding,
} from "./confirmation-nonce.ts";
export {
  consumeForGatedRoute,
  createConfirmationNonces,
  pruneUsedConfirmationNonces,
  type ConfirmationNonces,
  type ConfirmationNoncesOptions,
  type GatedRouteClaim,
} from "./confirmations.ts";
export { CONFIRM_DOWNLOADS, CONFIRMATION_SUBJECTS, REVIEWS } from "./reviews.ts";
export { expireProposals } from "./proposal-endings.ts";
export { notifyWaitingProposals, waitingByProposal } from "./proposal-waiting.ts";
export { emailReceipts } from "./receipts.ts";
export { ORIGIN_RETENTION_DAYS, pruneSecurityEventOrigins } from "./security-event-origins.ts";
export { currentTrustState, reconcileTrustState } from "./trust-state-reconciliation.ts";
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
export { countAgentWrite, recordHumanAction } from "./loop-limit.ts";
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
export { createWebCommands, type WebCommandOptions, type WebCommands, type WebResult } from "./web-commands.ts";
export { assertWebWrite, csrfTokenFor, webWriteProblem, type WebWriteRequest } from "./web-writes.ts";
