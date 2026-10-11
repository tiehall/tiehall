import type { ReactNode } from "react";
import {
  actorWords,
  clientParts,
  packetLinesOf,
  providerChangeLine,
  relativeTime,
  STATE_WORDS,
  type ActorClient,
  type EventActor,
  type RequestPageData,
} from "@tiehall/commands/web";
import { initialsOf, type ShellMember } from "@tiehall/commands/shell";
import { ActionForm } from "./action-form.tsx";
import { AppShell } from "./shell.tsx";

// The web UI's page of a request, as a server component renders it
// (agent-surfaces: Negotiated request URLs; agent-safety: The needs_human flag
// is visible and reaches the people on the request; requests: What a
// proposal records and shows; requests: Thread messages and blocking
// questions; web-ui: A request's state looks the same everywhere; web-ui: The
// request page shows who works on it and what happened; design.md, Design
// rules: Agent safety; design.md, Design: The page families; D57 (1), (15)).
// Its header shows the request's key in a mono tag, its state as a chip in
// words, a second chip when agents flagged it needs_human, since it then waits
// for a person, its due date, its title as the first-level heading, its two
// teams by key and name joined by a line that flows while work is under way,
// who opened it and when, and who holds its claim. A banner says who wrote on
// it last and when, and, while their agent is at work, that it is working on
// the request. Then two columns: the main one with its packet at the current
// revision and its thread, oldest message first, each message with its
// author, their team, whether they acted as an agent, with the client, or in
// the web UI, when, and what the message is; the side one with the actions
// the reader may take, the commitments they may propose, the proposals,
// newest first, each pending one with a link to its confirm page, where people
// confirm or reject it, and the timeline of its 20 latest events, each with a
// lamp in the color of the state it left the request in, that state in words,
// what happened, who and when. Everything people and agents wrote is text:
// React writes it escaped, so no markup in it runs or loads anything; a
// client's name sits in a bdi, apart from the mark Tiehall gives it, its
// verified host or "(unverified)", which no character of the name can
// reorder (web-ui: What the live hall shows of the people and agents at
// work); and a
// packet's link is an anchor to its http or https URL that tells the linked
// site nothing of the page. Tiehall's own words say what the page states.
//
// The page offers the actions its reader may take on the request, as their
// part in it and its state allow them (requests: Which side may act on a
// request; requests: Claiming and starting work need no proposal): a member of
// the target team claims an open request and starts work on a claimed one; the
// claimant releases the claim, and so may a member of the target team when
// the claimant is no longer a member; either side posts a comment, a question,
// which may be blocking, or an answer that names its question. Commitments
// wait as proposals, which the page lists with a link to their confirm page
// (requests: Commitments become proposals): a member of the target team
// proposes to decline the request, to mark it done or to reassign it to
// another team; the requester side proposes to withdraw it or changes its
// packet, which waits as a proposal while the request is claimed; either
// side proposes a due date, or its removal. Each is a form
// that runs through the page's server action (action-form.tsx), which runs the
// operation through execute() as the reader's web session, so what the page
// offers is only a convenience: execute() decides, and a refusal shows as the
// same call over /api/v1 would get it.

type Request = RequestPageData["request"];
type Message = Request["messages"][number];
type Packet = RequestPageData["packet"];
type Proposal = RequestPageData["proposals"][number];
type Activity = RequestPageData["activity"];
type User = { login: string; bot: boolean };

/** A user as the page names them: their GitHub login, marked when an admin flagged them as a bot. */
function person(user: User): string {
  return user.bot ? `${user.login} (a bot user)` : user.login;
}

/** A state's class, as the stylesheet names its chip and its lamp. */
function stateClass(state: string): string {
  return state.replace(/_/g, "-");
}

/** The states a lamp is drawn for; a request that ended otherwise has none. */
const LAMPED: ReadonlySet<string> = new Set(["open", "claimed", "in_progress", "needs_info", "done"]);

function StateChip({ state }: { state: Request["state"] }): ReactNode {
  return <span className={`chip ${stateClass(state)}`}>{STATE_WORDS[state]}</span>;
}

/** A lamp in a state's color, beside the words that say the state; hidden from assistive technology, which reads the words. */
function Lamp({ state }: { state: string }): ReactNode {
  return <span className={`lamp ${LAMPED.has(state) ? stateClass(state) : "none"}`} aria-hidden="true" />;
}

/** How long ago a moment was, from the moment the page's activity was read, with the moment itself as the element's date. */
function Ago({ at, now }: { at: string; now: string }): ReactNode {
  const ago = relativeTime(at, now);
  return <time dateTime={at}>{ago === "now" ? "just now" : `${ago} ago`}</time>;
}

/** A day such as 2026-10-24 as the page writes it: Oct 24, 2026. */
function dayWords(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Text someone wrote, line by line, each line break kept. */
function Lines({ text }: { text: string }): ReactNode {
  const lines = text.split(/\r?\n/);
  return lines.map((line, index) => (
    <span key={index}>
      {line}
      {index < lines.length - 1 ? <br /> : null}
    </span>
  ));
}

/** A section of the page, named by its heading, drawn as a panel. */
function Section({ id, title, className, children }: { id: string; title: string; className?: string; children: ReactNode }): ReactNode {
  return (
    <section aria-labelledby={id} className={className === undefined ? "panel" : `panel ${className}`}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/** A team by its key, in a mono tag, and its name. */
function TeamRef({ teamKey, name }: { teamKey: string; name: string | undefined }): ReactNode {
  return (
    <span className="team-ref">
      <span className="key">{teamKey}</span>
      {name === undefined || name === teamKey ? null : <span className="team-name">{name}</span>}
    </span>
  );
}

/** The line between the two teams, drawn from the requesting team to the target team; it flows while work is under way. */
function TeamLine({ flowing }: { flowing: boolean }): ReactNode {
  return (
    <svg className="team-line" viewBox="0 0 120 16" width="120" height="16" aria-hidden="true" focusable="false">
      <path className={flowing ? "line-flow" : undefined} d="M2 8 C 40 0, 80 16, 118 8" />
    </svg>
  );
}

/** The header: the key, the state, the needs_human and due date chips, the title, the two teams and who opened and claimed it. */
function RequestHead({ data }: { data: RequestPageData }): ReactNode {
  const { request, packet, teams, activity } = data;
  const nameOf = (key: string) => teams.find((team) => team.key === key)?.name;
  const due = packet.packet.due_date;
  const requester = request.requester.user === null ? `team ${request.requester.team.key}` : person(request.requester.user);
  return (
    <header className="request-head">
      <p className="request-tags">
        <span className="request-key">{request.key}</span>
        <StateChip state={request.state} />
        {request.needsHuman ? <span className="chip waits">Waits for a person</span> : null}
        {due === undefined ? null : <span className="chip due">{`Due ${dayWords(due)}`}</span>}
      </p>
      <h1>{request.untrusted.title}</h1>
      <div className="request-teams">
        <span className="visually-hidden">{`From team ${request.requester.team.key} to team ${request.targetTeam.key}:`}</span>
        <TeamRef teamKey={request.requester.team.key} name={nameOf(request.requester.team.key)} />
        <TeamLine flowing={request.state === "in_progress"} />
        <TeamRef teamKey={request.targetTeam.key} name={nameOf(request.targetTeam.key)} />
        <span className="request-who">
          {`Opened by ${requester} for team ${request.requester.team.key}, `}
          <Ago at={request.createdAt} now={activity.now} />
          {request.claimant === null ? " · nobody has claimed it" : ` · claimed by ${person(request.claimant)}`}
        </span>
      </div>
      {request.providerChange === null ? null : <p className="muted">{providerChangeLine(request.providerChange)}</p>}
    </header>
  );
}

/** The initials that stand for an actor where the page shows no avatar. */
function initialsFor(actor: EventActor): string {
  if (actor.user !== null) return initialsOf(actor.user.login);
  return { tiehall: "TH", github: "GH", jira: "JI", operator: "OP", agent: "AG", web: "WB" }[actor.kind];
}

/** A client: its name, the client's own claim, isolated in a bdi, then the mark Tiehall gives it, apart. */
function ClientName({ client }: { client: ActorClient }): ReactNode {
  const { name, mark } = clientParts(client);
  return (
    <>
      <bdi className="client-name">{name}</bdi>
      {mark === null ? null : (
        <>
          {" "}
          <span className="client-mark">{mark}</span>
        </>
      )}
    </>
  );
}

/**
 * The banner of who wrote on the request last, and when; while the request is
 * in_progress and that write is an agent's under 10 minutes old, it says that
 * the person's agent is working on it, with the client, and the three dots of
 * an agent at work pulse three times.
 */
function ActivityBanner({ request, activity }: { request: Request; activity: Activity }): ReactNode {
  const last = activity.lastWrite;
  if (last === null) return <p className="activity">Nobody has written on it yet.</p>;
  const { actor } = last;
  const client = actor.kind === "agent" && actor.client !== null ? actor.client : undefined;
  return (
    <div className={activity.agentAtWork ? "activity at-work" : "activity"}>
      <span className={actor.kind === "agent" ? "initials agent" : "initials"} aria-hidden="true">
        {initialsFor(actor)}
      </span>
      <p className="activity-what">
        {activity.agentAtWork ? (
          <>
            <strong>{`${actorWords(actor)} is working on ${request.key}`}</strong>
            {client === undefined ? null : (
              <>
                {" · "}
                <ClientName client={client} />
              </>
            )}{" "}
            <span className="typing" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </>
        ) : (
          <>
            {"Last write by "}
            <strong>{actorWords(actor)}</strong>
            {actor.kind === "web" ? (
              " in the web UI"
            ) : client === undefined ? null : (
              <>
                {" · "}
                <ClientName client={client} />
              </>
            )}
          </>
        )}
      </p>
      <p className="activity-when">
        {"Last write "}
        <Ago at={last.at} now={activity.now} />
      </p>
    </div>
  );
}

/**
 * The notice of a request agents flagged needs_human, which names both human
 * actions that clear the flag: a message posted in the web UI, and a proposal
 * on the request confirmed there (agent-safety: Runaway agent loops flag the
 * request needs_human; design.md, Decisions: D46 (7)).
 */
function WaitsForAPerson({ request }: { request: Request }): ReactNode {
  return (
    <p role="alert">
      <strong>{`${request.key} waits for a person: agents made so many writes on it that their writes are refused until a member posts a message on it here or confirms a proposal on it in the web UI.`}</strong>
    </p>
  );
}

function PacketSection({ packet }: { packet: Packet }): ReactNode {
  const { untrusted } = packet.packet;
  const due = packet.packet.due_date === undefined ? "with no due date" : `due ${packet.packet.due_date}`;
  return (
    <Section id="packet" title="Packet" className="packet">
      <p className="packet-meta">{`Revision ${packet.revision}, ${due}.`}</p>
      {packet.packet.kind === "contract_change" ? <p className="notice">This packet is a contract change.</p> : null}
      <h3>Need</h3>
      <p className="prose">
        <Lines text={untrusted.need} />
      </p>
      {untrusted.acceptance_criteria === undefined ? null : (
        <>
          <h3>Acceptance criteria</h3>
          <ul className="criteria">
            {untrusted.acceptance_criteria.map((criterion, index) => (
              <li key={index}>
                <Lines text={criterion} />
              </li>
            ))}
          </ul>
        </>
      )}
      {untrusted.code_refs === undefined ? null : (
        <>
          <h3>Code refs</h3>
          <ul className="code-refs">
            {untrusted.code_refs.map((ref, index) => (
              <li key={index}>
                <code>{[ref.repository, ref.path, ref.ref].filter((part) => part !== undefined).join(" ")}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {untrusted.links === undefined ? null : (
        <>
          <h3>Links</h3>
          <ul className="packet-links">
            {untrusted.links.map((link, index) => (
              <li key={index}>
                <a href={link.url} rel="noopener noreferrer nofollow">
                  {link.title ?? link.url}
                </a>
                {link.title === undefined ? null : <span className="muted">{` ${link.url}`}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {untrusted.contract === undefined ? null : <ContractSection contract={untrusted.contract} />}
      {untrusted.extensions === undefined ? null : (
        <>
          <h3>Extensions</h3>
          <pre>{JSON.stringify(untrusted.extensions, null, 2)}</pre>
        </>
      )}
    </Section>
  );
}

type Contract = NonNullable<Packet["packet"]["untrusted"]["contract"]>;

function ContractSection({ contract }: { contract: Contract }): ReactNode {
  return (
    <>
      <h3>Contract change</h3>
      <p>{`API ${contract.api}, from ${contract.base.ref} (${contract.base.sha}) to ${contract.head.ref} (${contract.head.sha}), classified by ${contract.engine.name} ${contract.engine.version}.`}</p>
      <p>{`Provider pull request ${contract.provider_pr.repository}#${contract.provider_pr.number}, ${contract.provider_status}.`}</p>
      <ul>
        {contract.changes.map((change, index) => (
          <li key={index}>{`${change.level} ${change.id}: ${change.operation}`}</li>
        ))}
      </ul>
      {contract.migration_notes === undefined ? null : (
        <p>
          <Lines text={contract.migration_notes} />
        </p>
      )}
      {contract.deprecation_window === undefined ? null : <p>{`The old behavior is served until ${contract.deprecation_window.end}.`}</p>}
    </>
  );
}

/** What a message is, in Tiehall's words, for its chip: its kind, and for a question whether it blocks and was answered. */
function kindWords(message: Message): string {
  if (message.kind === "question") return `${message.blocking ? "Blocking question" : "Question"} · ${message.answered === true ? "answered" : "not answered yet"}`;
  return message.kind === "answer" ? "Answer" : "Comment";
}

/** Who posted a message, as the activity read names them, or else from the message's own provenance. */
function authorOf(message: Message, activity: Activity): EventActor {
  const named = activity.authors.find(({ messageId }) => messageId === message.id)?.actor;
  if (named !== undefined) return named;
  const { provenance } = message;
  const user = provenance.user === null ? null : { ...provenance.user, kind: "human" as const };
  if (provenance.actorKind === "agent") return { kind: "agent", user, client: null };
  if (provenance.actorKind === "web_session") return { kind: "web", user, client: null };
  if (provenance.actorKind === "integration") return { kind: provenance.surface === "jira" ? "jira" : "github", user: null, client: null };
  return { kind: "tiehall", user: null, client: null };
}

/** One message of the thread: its author's initials, who they are and how they posted it, when, what it is, and its text. */
function MessageItem({ message, activity }: { message: Message; activity: Activity }): ReactNode {
  const author = authorOf(message, activity);
  const team = message.provenance.team;
  const answered = message.kind === "question" && message.answered === true;
  return (
    <article id={`message-${message.id}`} className={message.kind === "question" && message.blocking ? "message blocking" : "message"}>
      <span className={author.kind === "agent" ? "initials agent" : "initials"} aria-hidden="true">
        {initialsFor(author)}
      </span>
      <div className="message-body">
        <p className="message-meta">
          <strong>{actorWords(author)}</strong>
          {team === null ? null : ` · team ${team.key}`}
          {author.kind === "web" ? " · web" : null}
          {author.kind !== "agent" ? null : author.client === null ? (
            " · agent"
          ) : (
            <>
              {" · agent · "}
              <ClientName client={author.client} />
            </>
          )}
          {" · "}
          <Ago at={message.postedAt} now={activity.now} />
          {message.editedAt === null ? null : ` · edited, version ${message.version}`}{" "}
          <span className={answered ? "chip kind answered" : "chip kind"}>{kindWords(message)}</span>
        </p>
        <div className="bubble">
          <p>
            <Lines text={message.untrusted.body} />
          </p>
        </div>
      </div>
    </article>
  );
}

/** A question's text as the thread's form names it, to pick the question an answer answers: its first line, cut short. */
function excerpt(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** The form that posts a comment, a question or an answer in the thread. */
function PostForm({ request, csrf }: { request: Request; csrf: string }): ReactNode {
  const questions = request.messages.filter((message) => message.kind === "question");
  return (
    <ActionForm requestKey={request.key} action="post" csrf={csrf} button="Post" className="post-form">
      <div className="field">
        <label htmlFor="body">Message</label>
        <textarea id="body" name="body" rows={4} required />
      </div>
      <div className="post-options">
        <div className="field">
          <label htmlFor="kind">Kind</label>
          <select id="kind" name="kind" defaultValue="comment">
            <option value="comment">Comment</option>
            <option value="question">Question</option>
            <option value="answer">Answer</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="questionId">Question it answers (an answer only)</label>
          <select id="questionId" name="questionId" defaultValue="">
            <option value="">None</option>
            {questions.map((question) => (
              <option key={question.id} value={question.id}>
                {`${question.provenance.user?.login ?? "Tiehall"}, ${question.postedAt}: ${excerpt(question.untrusted.body)}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="check">
        <input type="checkbox" id="blocking" name="blocking" /> <label htmlFor="blocking">Blocking: the request waits for its answer (a question only)</label>
      </p>
    </ActionForm>
  );
}

/**
 * The thread, oldest message first, and below it, in the same panel, where the
 * two sides post in it; anyone else is told that only they do. The thread and
 * the form are regions of their own, so the thread holds only its messages.
 */
function ThreadSection({ request, parts, csrf, activity }: { request: Request; parts: Parts; csrf: string; activity: Activity }): ReactNode {
  return (
    <div className="panel thread">
      <section aria-labelledby="thread">
        <h2 id="thread">Thread</h2>
        {request.messages.length === 0 ? <p className="muted">No message yet.</p> : null}
        {request.messages.map((message) => (
          <MessageItem key={message.id} message={message} activity={activity} />
        ))}
      </section>
      <section aria-labelledby="post" className="post">
        <h3 id="post">Write on the request</h3>
        {parts.targetTeam || parts.requesterSide ? <PostForm request={request} csrf={csrf} /> : <p className="muted">Only the two sides of the request post in its thread.</p>}
      </section>
    </div>
  );
}

/** The reader's parts in the request, from the teams whoami gives them: the target team, the requester side, the claim. */
interface Parts {
  targetTeam: boolean;
  requesterSide: boolean;
  claimant: boolean;
}

function partsOf({ request, viewer }: Pick<RequestPageData, "request" | "viewer">): Parts {
  const teams = new Set(viewer.teams.map(({ id }) => id));
  return {
    targetTeam: teams.has(request.targetTeam.id),
    requesterSide: request.requester.user?.id === viewer.user.id || teams.has(request.requester.team.id),
    claimant: request.claimant !== null && request.claimant.id === viewer.user.id,
  };
}

/** The states that end a request. */
const TERMINAL: ReadonlySet<string> = new Set(["done", "declined", "withdrawn"]);

/** The direct actions the reader may take on the request as it is now, each a form with its one button. */
function ActionsSection({ request, parts, csrf }: { request: Request; parts: Parts; csrf: string }): ReactNode {
  const forms: ReactNode[] = [];
  const { key, state, claimant, targetTeam } = request;
  if (state === "open" && parts.targetTeam) forms.push(<ActionForm key="claim" requestKey={key} action="claim" csrf={csrf} button="Claim" className="stack" />);
  if (state === "claimed" && parts.targetTeam) forms.push(<ActionForm key="start" requestKey={key} action="start" csrf={csrf} button="Start work" className="stack" />);
  if (claimant !== null && !TERMINAL.has(state) && (parts.claimant || parts.targetTeam)) {
    forms.push(
      <ActionForm key="release" requestKey={key} action="release" csrf={csrf} button="Release the claim" className="stack" buttonClass="secondary">
        {parts.claimant ? null : <p className="hint">{`A member of team ${targetTeam.key} may release a claim held by someone who is no longer a member of the install.`}</p>}
      </ActionForm>,
    );
  }
  return (
    <Section id="actions" title="Actions" className="side-panel">
      {forms.length === 0 ? <p className="hint">There is no action for you to take on it here now.</p> : forms}
    </Section>
  );
}

/** Each kind of commitment, as the page names a proposal of it. */
const COMMITMENTS: Readonly<Record<string, string>> = {
  due_date: "A due date",
  scope: "A scope change",
  decline: "A decline",
  reassign: "A reassignment",
  withdraw: "A withdrawal",
  done: "Marking it done",
};

/** Who may give the other side's confirmation, in Tiehall's words. */
function otherSide(rules: readonly string[], team: { key: string } | null): string {
  const words: Readonly<Record<string, string>> = {
    target_team: `a member of team ${team?.key ?? ""}`,
    requester_side: `the requesting user or a member of team ${team?.key ?? ""}`,
    claimant: "the claimant",
  };
  return rules.map((rule) => words[rule] ?? rule).join(" and ");
}

function proposalLines(proposal: Proposal): string[] {
  const lines = [`${COMMITMENTS[proposal.kind] ?? proposal.kind}, ${proposal.state}, proposed by ${person(proposal.proposedBy.user)} at ${proposal.createdAt}.`];
  if (proposal.change.dueDate !== undefined) {
    lines.push(proposal.change.dueDate === null ? "It proposes to remove the due date." : `It proposes the due date ${proposal.change.dueDate}.`);
  }
  if (proposal.change.team !== undefined) lines.push(`It proposes team ${proposal.change.team.key}.`);
  if (proposal.kind === "scope") lines.push("It proposes a new revision of the packet.");
  const needed = proposal.confirmations.needed.map((step) => (step.user === null ? otherSide(step.rules, step.team) : person(step.user)));
  const received = proposal.confirmations.received.map((confirmation) => `${person(confirmation.user)} confirmed at ${confirmation.confirmedAt}`);
  lines.push(`It needs the confirmation of ${needed.join(", then ")}${received.length === 0 ? ", and has none yet." : `; ${received.join(", ")}.`}`);
  lines.push(
    proposal.state === "pending"
      ? `It expires at ${proposal.expiresAt}.`
      : `It ended at ${proposal.endedAt ?? ""}${proposal.cancelReason === null ? "" : `, cancelled: ${proposal.cancelReason.replace(/_/g, " ")}`}.`,
  );
  return lines;
}

function ProposalsSection({ proposals }: { proposals: readonly Proposal[] }): ReactNode {
  return (
    <Section id="proposals" title="Proposals" className="side-panel">
      {proposals.length === 0 ? <p className="hint">No proposal yet.</p> : null}
      {proposals.map((proposal) => (
        <article key={proposal.id} id={`proposal-${proposal.id}`} className={proposal.state === "pending" ? "proposal pending" : "proposal"}>
          {proposalLines(proposal).map((line, index) => (
            <p key={index}>{line}</p>
          ))}
          {proposal.state === "pending" ? (
            <p>
              <a className="button" href={`/confirm/${proposal.id}`}>
                Review it, then confirm or reject it
              </a>
            </p>
          ) : null}
        </article>
      ))}
    </Section>
  );
}

/** The states from which a request can be marked done. */
const DONE_FROM: ReadonlySet<string> = new Set(["claimed", "in_progress", "needs_info"]);

/** The form that changes the packet's text fields, filled with the current revision's. */
function PacketForm({ request, packet, csrf }: { request: Request; packet: Packet; csrf: string }): ReactNode {
  const { untrusted } = packet.packet;
  const lines = packetLinesOf(untrusted);
  return (
    // A panel with no region of its own, so the packet's region is the one named Packet.
    <div className="panel">
      <h2>Change the packet</h2>
      <ActionForm requestKey={request.key} action="change_packet" csrf={csrf} button="Change the packet" className="packet-form" buttonClass="secondary">
        <input type="hidden" name="revision" value={String(packet.revision)} />
        <p className="hint">
          {request.claimant === null
            ? "While nobody holds its claim, a change is the packet's next revision at once."
            : "While it is claimed, a change of its need or acceptance criteria waits as a proposal that you, then the claimant, confirm."}
        </p>
        <div className="field">
          <label htmlFor="need">Need</label>
          <textarea id="need" name="need" defaultValue={untrusted.need} required />
        </div>
        <div className="field">
          <label htmlFor="acceptanceCriteria">Acceptance criteria, one per line</label>
          <textarea id="acceptanceCriteria" name="acceptanceCriteria" defaultValue={lines.acceptanceCriteria} />
        </div>
        <div className="field">
          <label htmlFor="codeRefs">Code refs, one per line: a repository, then a path and a ref if you like</label>
          <textarea id="codeRefs" name="codeRefs" defaultValue={lines.codeRefs} />
        </div>
        <div className="field">
          <label htmlFor="links">Links, one per line: a URL, then a title if you like</label>
          <textarea id="links" name="links" defaultValue={lines.links} />
        </div>
      </ActionForm>
    </div>
  );
}

/** The commitments the reader may propose on the request as it is now, each a form whose proposal waits for its confirmations. */
function CommitmentsSection({ data, parts, csrf }: { data: RequestPageData; parts: Parts; csrf: string }): ReactNode {
  const { request, packet, teams } = data;
  const { key, state } = request;
  const forms: ReactNode[] = [];
  if (!TERMINAL.has(state)) {
    if (parts.targetTeam) {
      if (DONE_FROM.has(state)) forms.push(<ActionForm key="done" requestKey={key} action="done" csrf={csrf} button="Mark done" className="stack" />);
      forms.push(<ActionForm key="decline" requestKey={key} action="decline" csrf={csrf} button="Decline" className="stack" buttonClass="secondary" />);
      const others = teams.filter((team) => team.key !== request.targetTeam.key);
      if (others.length > 0) {
        forms.push(
          <ActionForm key="reassign" requestKey={key} action="reassign" csrf={csrf} button="Reassign" className="stack" buttonClass="secondary">
            <div className="field">
              <label htmlFor="team">Team to reassign it to</label>
              <select id="team" name="team">
                {others.map((team) => (
                  <option key={team.key} value={team.key}>
                    {team.key === team.name ? team.key : `${team.key} · ${team.name}`}
                  </option>
                ))}
              </select>
            </div>
          </ActionForm>,
        );
      }
    }
    if (parts.requesterSide) forms.push(<ActionForm key="withdraw" requestKey={key} action="withdraw" csrf={csrf} button="Withdraw" className="stack" buttonClass="secondary" />);
    if (parts.targetTeam || parts.requesterSide) {
      forms.push(
        <ActionForm key="due_date" requestKey={key} action="due_date" csrf={csrf} button="Propose the due date" className="stack" buttonClass="secondary">
          <input type="hidden" name="revision" value={String(packet.revision)} />
          <div className="field">
            <label htmlFor="dueDate">Due date</label>
            <input type="date" id="dueDate" name="dueDate" required />
          </div>
        </ActionForm>,
      );
      if (packet.packet.due_date !== undefined) {
        forms.push(
          <ActionForm key="remove_due_date" requestKey={key} action="remove_due_date" csrf={csrf} button="Propose removing the due date" className="stack" buttonClass="secondary">
            <input type="hidden" name="revision" value={String(packet.revision)} />
          </ActionForm>,
        );
      }
    }
  }
  return (
    <Section id="commitments" title="Commitments" className="side-panel">
      <p className="hint">
        A commitment waits as a proposal until the people it needs confirm it on its confirm page. A due date, and a change of the need or the
        acceptance criteria while the request is claimed, need a confirmation from each side.
      </p>
      {forms.length === 0 ? <p className="hint">There is no commitment for you to propose on it now.</p> : forms}
    </Section>
  );
}

/** The timeline of the request's 20 latest events, newest first: a lamp and the state it left the request in, what happened, who and when. */
function TimelineSection({ activity }: { activity: Activity }): ReactNode {
  return (
    <Section id="timeline" title="Timeline" className="side-panel">
      {activity.events.length === 0 ? <p className="hint">Nothing has happened to it yet.</p> : null}
      <ol className="timeline">
        {activity.events.map((event) => (
          <li key={event.number} className={`event ${stateClass(event.state)}`}>
            <Lamp state={event.state} />
            <div>
              <p className="event-what">{event.line}</p>
              <p className="event-who">
                <span className="event-state">{STATE_WORDS[event.state]}</span>
                {` · ${actorWords(event.actor)} · `}
                <Ago at={event.at} now={activity.now} />
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/** The page of a request, whose forms carry the reader's CSRF token. */
export function RequestPage({ data, csrf, shell }: { data: RequestPageData; csrf: string; shell: { member: ShellMember; path: string } }): ReactNode {
  const { request, packet, proposals, activity } = data;
  const parts = partsOf(data);
  return (
    <AppShell member={shell.member} path={shell.path} csrf={csrf} className="request-page">
      <title>{`${request.key}: ${request.untrusted.title} · Tiehall`}</title>
      <RequestHead data={data} />
      {request.needsHuman ? <WaitsForAPerson request={request} /> : null}
      <ActivityBanner request={request} activity={activity} />
      <div className="request-columns">
        <div className="request-main">
          <PacketSection packet={packet} />
          <ThreadSection request={request} parts={parts} csrf={csrf} activity={activity} />
          {!TERMINAL.has(request.state) && parts.requesterSide ? <PacketForm request={request} packet={packet} csrf={csrf} /> : null}
        </div>
        <div className="request-side">
          <ActionsSection request={request} parts={parts} csrf={csrf} />
          <CommitmentsSection data={data} parts={parts} csrf={csrf} />
          <ProposalsSection proposals={proposals} />
          <TimelineSection activity={activity} />
        </div>
      </div>
    </AppShell>
  );
}
