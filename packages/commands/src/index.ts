// @tiehall/commands: execute() and one handler per command definition; everything that touches the database, the queue or the network.
export { type AppendedEvent } from "./append-event.ts";
export {
  clientRegistrations,
  readAgentClient,
  REGISTRATION_LIMIT_CODE,
  REGISTRATIONS_PER_ADDRESS_PER_HOUR,
  removeUnusedAgentClients,
  UNUSED_CLIENT_DAYS,
  type AgentClient,
  type ClientRegistrationOptions,
} from "./agent-clients.ts";
export {
  authorizationRequestOf,
  clientParametersOf,
  consentReview,
  consentViewIn,
  continuePathOf,
  createConsentRoute,
  isAuthorizationRequest,
  isRegisteredRedirect,
  type AuthorizationRequest,
  type ConsentRoute,
  type ConsentRouteOptions,
  type ConsentView,
} from "./consent.ts";
export { createAgentTokenCheck, type AgentTokenCheck, type AgentTokenCheckOptions, type SigningKeys } from "./agent-tokens.ts";
export {
  CLI_CLIENT_ID,
  cliDeviceFlow,
  DEVICE_APPROVAL_PATH,
  DEVICE_CODE_GRANT_TYPE,
  DEVICE_CODE_LIFETIME_SECONDS,
  deviceScopeOf,
  removeExpiredDeviceCodes,
  seedCliClient,
  type CliDeviceFlowOptions,
} from "./device-flow.ts";
export {
  createTokensRoute,
  findPersonalAccessToken,
  newPersonalAccessToken,
  PERSONAL_ACCESS_TOKEN_MAX_DAYS,
  personalAccessTokenHash,
  personalAccessTokenSettingsIn,
  TOKENS_PATH,
  type FoundPersonalAccessToken,
} from "./personal-access-tokens.ts";
export {
  personalAccessTokenReminderViews,
  REMINDER_DAYS_BEFORE,
  remindPersonalAccessTokenOwners,
  type PersonalAccessTokenReminderView,
} from "./personal-access-token-reminders.ts";
export {
  createDeviceApprovalRoute,
  normalizeUserCode,
  type DeviceApprovalRoute,
  type DeviceApprovalRouteOptions,
} from "./device-approval.ts";
export {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  AUTHORIZATION_ENDPOINT_PATH,
  AUTHORIZATION_SIGN_IN_PATH,
  METADATA_FETCHES_PER_HOST_PER_MINUTE,
  authorizationServerPlugins,
  CONSENT_PATH,
  MCP_PATH,
  mcpResourceOf,
  REFRESH_SCOPE,
  resourceMetadataUrlOf,
  type AgentClientOptions,
  type AuthorizationServerOptions,
} from "./authorization-server.ts";
export {
  BODY_LIMIT,
  bodyLimitFor,
  CONTRACT_REPORT_BODY_LIMIT,
  declaredLength,
  GITHUB_WEBHOOK_BODY_LIMIT,
  MIB,
  payloadTooLarge,
  readBoundedBody,
  WEBHOOK_BODY_LIMITS,
} from "./body-limit.ts";
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
  definePreparedHandler,
  OutputSchemaError,
  type ConfirmationClaim,
  type Confirmations,
  type Execute,
  type ExecuteOptions,
  type ExecuteServices,
  type Handler,
  type HandlerContext,
  type Handlers,
  type Prepare,
  type PrepareContext,
} from "./execute.ts";
export {
  buildAppManifest,
  GITHUB_APP_ACCESS,
  manifestHasWebhook,
  MANIFEST_REDIRECT_PATH,
  SETUP_SIGN_IN_CALLBACK_PATH,
  SETUP_SIGN_IN_PATH,
  SIGN_IN_CALLBACK_PATH,
  WEBHOOK_PATH,
  type AppManifest,
  type AppManifestInput,
} from "./github-manifest.ts";
export {
  checkAppKey,
  convertManifestCode,
  createGitHubClient,
  everyPage,
  pagesOf,
  GITHUB_API_URL,
  GITHUB_REQUEST_TIMEOUT_MS,
  GitHubUnavailableError,
  readSignedInUser,
  type SignedInUser,
  type ConvertedApp,
  type GitHubAppCredentials,
  type GitHubClient,
  type GitHubClientOptions,
} from "./github-client.ts";
export {
  readGitHubApp,
  readReplacedGitHubApps,
  recordReplacedGitHubApp,
  storeGitHubApp,
  type ReplacedGitHubApp,
  type StoredGitHubApp,
} from "./github-app.ts";
export { GITHUB_APP_KEY_HANDLERS, GITHUB_APP_KEY_REVIEWS } from "./github-app-key.ts";
export {
  GITHUB_EVENT_PROCESSORS,
  processDelivery,
  type DeliveryProcessingServices,
  type GitHubEvent,
  type GitHubEventContext,
  type GitHubEventProcessor,
  type GitHubEventProcessors,
} from "./github-delivery-processing.ts";
export {
  connectInstallations,
  coveredRepositories,
  coveringInstallation,
  knownInstallations,
  listAppInstallations,
  listInstallationRepositories,
  readInstallations,
  readRepositoriesOf,
  recordCoveredRepositories,
  recordInstallations,
  syncGitHubInstallations,
  type CoveredRepository,
  type GitHubAppAccess,
  type KnownInstallation,
  type ListedInstallation,
  type ListedRepository,
  type ReadInstallationsOptions,
} from "./github-installations.ts";
export { askRedelivery, attemptFailed, madeAfter, readDeliveryLog, type DeliveryAttempt } from "./github-delivery-log.ts";
export {
  checkDeliveryLog,
  checkGitHubDeliveryLog,
  GITHUB_MODE_HANDLERS,
  GITHUB_MODE_REVIEWS,
  GITHUB_MODES,
  GITHUB_WEBHOOK_SECRET_HANDLERS,
  githubModeOf,
  settleModeFromDeliveryLog,
  type DeliveryLogCheckOptions,
  type GitHubMode,
} from "./github-mode.ts";
export { REDELIVERY_ASKS, redeliverFailedDeliveries, redeliverGitHubDeliveries, type RedeliveryOptions } from "./github-redelivery.ts";
export { changeKeyOf, polledDeliveryId, pullRequestChangeKey } from "./github-changes.ts";
export { PROCESSED_DELIVERY_RETENTION_DAYS, pruneGitHubDeliveries, UNPROCESSED_DELIVERY_RETENTION_DAYS } from "./github-delivery-pruning.ts";
export { pollGitHub, pollGitHubChanges, type PollOptions } from "./github-polling.ts";
export { userOfGitHubAccount } from "./github-users.ts";
export {
  createGitHubWebhookRoute,
  processGitHubDelivery,
  releaseHeldDeliveries,
  releaseHeldGitHubDeliveries,
  type GitHubWebhookRoute,
  type GitHubWebhookRouteOptions,
} from "./github-webhooks.ts";
export {
  COMPANY_NAME_MAX_LENGTH,
  COMPANY_PATH,
  companyName,
  defaultAppName,
  GITHUB_WEB_URL,
  MANIFEST_STATE_LIFETIME_SECONDS,
  manifestState,
  manifestStateNonce,
  UNREACHABLE_OPTION,
} from "./setup-github.ts";
export { createInstallGitHub, type InstallGitHub, type InstallGitHubOptions } from "./install-github.ts";
export { completeSetup, SetupCompletionError, type CompleteSetupOptions } from "./setup-completion.ts";
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
export { createMcpRoute, MCP_SERVER_NAME, type McpRoute, type McpRouteOptions } from "./mcp.ts";
export {
  bindingContext,
  callDigest,
  createRetryStates,
  REQUEST_STATE_TTL_SECONDS,
  retryBinding,
  type RetryState,
} from "./mcp-elicitation.ts";
export { TOOL_TEXTS, toolTexts, type ToolText } from "./mcp-texts.ts";
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
  isTrialUrl,
  readAppDatabase,
  readAppSettings,
  readAuthSecret,
  readClientMetadataFetch,
  readMigrateSettings,
  readSecretKey,
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
export { refusalAnswer, refusalAnswerAs, type RefusalAnswer, type WayOn } from "./html.ts";
export { pageRouteNegotiatesHtml, wayOnOfPageRoute } from "./page-routes.ts";
export {
  MEDIA_TYPES,
  NEGOTIATED_VARY,
  negotiate,
  requestUrlNegotiatesHtml,
  requestUrlOf,
  varyOnNegotiatedUrls,
  withNegotiatedVary,
  type Representation,
  type RequestUrlPath,
} from "./negotiation.ts";
export { createRequestUrlRoute, requestEtag, type RequestUrlAnswer, type RequestUrlOptions, type RequestUrlRoute } from "./request-urls.ts";
export { createNewRequestRoute, NEW_REQUEST_PATH } from "./new-request.ts";
export { createRequestListsRoute, REQUEST_LIST_PAGE_SIZE, REQUEST_LISTS_PATH } from "./request-lists.ts";
export { readRequestPage, readRequestPageAs, requestPageFacts, type PageRead, type RequestPageData, type RequestWithThreadView } from "./request-page-data.ts";
export {
  AUTH_BASE_PATH,
  createSignInService,
  SESSION_IDLE_DAYS,
  SESSION_LIFETIME_DAYS,
  SESSION_UPDATE_AGE_DAYS,
  SETUP_SIGN_IN_REFUSED,
  SIGN_IN_PATH,
  SIGN_IN_REFUSED,
  SIGN_OUT_PATH,
  type SetupSignIn,
  type SignInService,
  type SignInServiceOptions,
} from "./sign-in.ts";
export { renewingSession, sessionCookiesOf, withSessionCookies, type SessionCookie } from "./session-renewal.ts";
export { routeInventory, servedOverHttp, SIGN_IN_ROUTES, unclassifiedRoutes, type SignInRouteClass } from "./sign-in-routes.ts";
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
export {
  CONFIRM_PATH,
  CONFIRM_ROUTE_PATHS,
  createConfirmRoute,
  renderReviewPage,
  type ConfirmDownloads,
  type ConfirmEntries,
  type ConfirmMessage,
  type ConfirmMessages,
  type ConfirmRedirects,
  type ConfirmRoute,
  type ConfirmRouteOptions,
  type Download,
} from "./confirm-route.ts";
export { createHomeRoute, type HomeRoute, type HomeRouteOptions } from "./home-route.ts";
export { ACTIVITY_LOG_PATH, createActivityLogRoute, type ActivityLogRoute, type ActivityLogRouteOptions } from "./activity-log-route.ts";
export { createGitHubAdminRoute, GITHUB_ADMIN_PATH, type GitHubAdminRoute, type GitHubAdminRouteOptions } from "./github-admin-route.ts";
export {
  createInvitesRoute,
  createMembersRoute,
  createPersonalAccessTokenSettingsRoute,
  createSignInPolicyRoute,
  createTeamsRoute,
  INVITES_PATH,
  MEMBERS_PATH,
  PERSONAL_ACCESS_TOKEN_SETTINGS_PATH,
  SIGN_IN_POLICY_PATH,
  TEAMS_PATH,
} from "./admin-pages.ts";
export { createPageRoute, type PageCalls, type PageHandlers, type PageRoute, type PageRouteOptions } from "./web-pages.ts";
export { GITHUB_INSTALLATION_HANDLERS, GITHUB_INSTALLATION_REVIEWS } from "./github-installation-changes.ts";
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
export { CONFIRM_DOWNLOADS, CONFIRM_ENTRIES, CONFIRM_MESSAGES, CONFIRM_REDIRECTS, CONFIRMATION_SUBJECTS, REVIEWS } from "./reviews.ts";
export { AGENT_GRANT_HANDLERS, AGENT_GRANT_REDIRECTS, AGENT_GRANT_REVIEWS } from "./agent-grants.ts";
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
export { reconcileGitHub } from "./github-reconciliation.ts";
export { checkDepartures, departureOf, processOrganizationEvent, type Departure, type DepartureScope, type DepartureServices } from "./organization-departures.ts";
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
