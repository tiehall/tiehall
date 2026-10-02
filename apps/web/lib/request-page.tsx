import type { ReactNode } from "react";
import { packetLinesOf, providerChangeLine, type RequestPageData } from "@tiehall/commands/web";
import { ActionForm } from "./action-form.tsx";

// The web UI's page of a request, as a server component renders it
// (agent-surfaces: Negotiated request URLs; agent-safety: The needs_human flag
// is visible and reaches the people on the request; requests: What a
// proposal records and shows; requests: Thread messages and blocking
// questions; design.md, Design rules: Agent safety). It shows the request's
// key and title, its state, its teams, who opened it and who holds its claim;
// a notice when agents flagged it needs_human, since it then waits for a
// person; its packet at the current revision; its thread, oldest message
// first, with what each message is and who posted it; and its proposals,
// newest first, with what each proposes, the confirmations it needs and has,
// and, while it waits, a link to its confirm page, where people confirm or
// reject it. Everything people and agents wrote is text: React writes it
// escaped, so no markup in it runs or loads anything, and a packet's link is
// an anchor to its http or https URL that tells the linked site nothing of the
// page. Tiehall's own words say what the page states.
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
type User = { login: string; bot: boolean };

/** A user as the page names them: their GitHub login, marked when an admin flagged them as a bot. */
function person(user: User): string {
  return user.bot ? `${user.login} (a bot user)` : user.login;
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

/** A section of the page, named by its heading. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }): ReactNode {
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function Summary({ request }: { request: Request }): ReactNode {
  const requester = request.requester.user === null ? `team ${request.requester.team.key}` : `${person(request.requester.user)} for team ${request.requester.team.key}`;
  return (
    <>
      <p>{`${request.key} is ${request.state}, addressed to team ${request.targetTeam.key}.`}</p>
      <p>{`Requested by ${requester} at ${request.createdAt}.`}</p>
      <p>{request.claimant === null ? "Nobody has claimed it." : `Claimed by ${person(request.claimant)}.`}</p>
      {request.providerChange === null ? null : <p>{providerChangeLine(request.providerChange)}</p>}
    </>
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
    <Section id="packet" title="Packet">
      <p>{`Revision ${packet.revision}, ${due}.`}</p>
      {packet.packet.kind === "contract_change" ? <p>This packet is a contract change.</p> : null}
      <h3>Need</h3>
      <p>
        <Lines text={untrusted.need} />
      </p>
      {untrusted.acceptance_criteria === undefined ? null : (
        <>
          <h3>Acceptance criteria</h3>
          <ul>
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
          <ul>
            {untrusted.code_refs.map((ref, index) => (
              <li key={index}>{[ref.repository, ref.path, ref.ref].filter((part) => part !== undefined).join(" ")}</li>
            ))}
          </ul>
        </>
      )}
      {untrusted.links === undefined ? null : (
        <>
          <h3>Links</h3>
          <ul>
            {untrusted.links.map((link, index) => (
              <li key={index}>
                <a href={link.url} rel="noopener noreferrer nofollow">
                  {link.title ?? link.url}
                </a>
                {link.title === undefined ? null : ` ${link.url}`}
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
      {contract.deprecation_window === undefined ? null : (
        <p>{`The old behavior is served until ${contract.deprecation_window.end}.`}</p>
      )}
    </>
  );
}

/** What a message is and who posted it, in Tiehall's words. */
function messageLine(message: Message): string {
  const what =
    message.kind === "question"
      ? `${message.blocking ? "A blocking question" : "A question"}, ${message.answered === true ? "answered" : "not answered yet"}`
      : message.kind === "answer"
        ? "An answer"
        : "A comment";
  const { provenance } = message;
  const by =
    provenance.actorKind === "system"
      ? "Tiehall"
      : provenance.user === null
        ? provenance.team === null
          ? provenance.actorKind
          : `team ${provenance.team.key}`
        : `${person(provenance.user)}${provenance.team === null ? "" : ` for team ${provenance.team.key}`}`;
  const through = provenance.surface === null ? "" : `, through ${provenance.surface}`;
  const edited = message.editedAt === null ? "" : `, edited at ${message.editedAt} (version ${message.version})`;
  return `${what}, from ${by}${through}, at ${message.postedAt}${edited}:`;
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
    <ActionForm requestKey={request.key} action="post" csrf={csrf} button="Post">
      <p>
        <label htmlFor="kind">Kind</label>{" "}
        <select id="kind" name="kind" defaultValue="comment">
          <option value="comment">Comment</option>
          <option value="question">Question</option>
          <option value="answer">Answer</option>
        </select>
      </p>
      <p>
        <input type="checkbox" id="blocking" name="blocking" /> <label htmlFor="blocking">Blocking: the request waits for its answer (a question only)</label>
      </p>
      <p>
        <label htmlFor="questionId">Question it answers (an answer only)</label>{" "}
        <select id="questionId" name="questionId" defaultValue="">
          <option value="">None</option>
          {questions.map((question) => (
            <option key={question.id} value={question.id}>
              {`${question.provenance.user?.login ?? "Tiehall"}, ${question.postedAt}: ${excerpt(question.untrusted.body)}`}
            </option>
          ))}
        </select>
      </p>
      <p>
        <label htmlFor="body">Message</label>
      </p>
      <p>
        <textarea id="body" name="body" required />
      </p>
    </ActionForm>
  );
}

/** Where the two sides post in the thread; anyone else is told that only they do. */
function PostSection({ request, parts, csrf }: { request: Request; parts: Parts; csrf: string }): ReactNode {
  return (
    <Section id="post" title="Write on the request">
      {parts.targetTeam || parts.requesterSide ? <PostForm request={request} csrf={csrf} /> : <p>Only the two sides of the request post in its thread.</p>}
    </Section>
  );
}

function ThreadSection({ messages }: { messages: readonly Message[] }): ReactNode {
  return (
    <Section id="thread" title="Thread">
      {messages.length === 0 ? <p>No message yet.</p> : null}
      {messages.map((message) => (
        <article key={message.id} id={`message-${message.id}`}>
          <p>{messageLine(message)}</p>
          <p>
            <Lines text={message.untrusted.body} />
          </p>
        </article>
      ))}
    </Section>
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
  if (state === "open" && parts.targetTeam) forms.push(<ActionForm key="claim" requestKey={key} action="claim" csrf={csrf} button="Claim" />);
  if (state === "claimed" && parts.targetTeam) forms.push(<ActionForm key="start" requestKey={key} action="start" csrf={csrf} button="Start work" />);
  if (claimant !== null && !TERMINAL.has(state) && (parts.claimant || parts.targetTeam)) {
    forms.push(
      <ActionForm key="release" requestKey={key} action="release" csrf={csrf} button="Release the claim">
        {parts.claimant ? null : <p>{`A member of team ${targetTeam.key} may release a claim held by someone who is no longer a member of the install.`}</p>}
      </ActionForm>,
    );
  }
  return (
    <Section id="actions" title="Actions">
      {forms.length === 0 ? <p>There is no action for you to take on it here now.</p> : forms}
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
    <Section id="proposals" title="Proposals">
      {proposals.length === 0 ? <p>No proposal yet.</p> : null}
      {proposals.map((proposal) => (
        <article key={proposal.id} id={`proposal-${proposal.id}`}>
          {proposalLines(proposal).map((line, index) => (
            <p key={index}>{line}</p>
          ))}
          {proposal.state === "pending" ? (
            <p>
              <a href={`/confirm/${proposal.id}`}>Review it, then confirm or reject it</a>
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
    <ActionForm requestKey={request.key} action="change_packet" csrf={csrf} button="Change the packet">
      <input type="hidden" name="revision" value={String(packet.revision)} />
      <p>
        {request.claimant === null
          ? "While nobody holds its claim, a change is the packet's next revision at once."
          : "While it is claimed, a change of its need or acceptance criteria waits as a proposal that you, then the claimant, confirm."}
      </p>
      <p>
        <label htmlFor="need">Need</label>
      </p>
      <p>
        <textarea id="need" name="need" defaultValue={untrusted.need} required />
      </p>
      <p>
        <label htmlFor="acceptanceCriteria">Acceptance criteria, one per line</label>
      </p>
      <p>
        <textarea id="acceptanceCriteria" name="acceptanceCriteria" defaultValue={lines.acceptanceCriteria} />
      </p>
      <p>
        <label htmlFor="codeRefs">Code refs, one per line: a repository, then a path and a ref if you like</label>
      </p>
      <p>
        <textarea id="codeRefs" name="codeRefs" defaultValue={lines.codeRefs} />
      </p>
      <p>
        <label htmlFor="links">Links, one per line: a URL, then a title if you like</label>
      </p>
      <p>
        <textarea id="links" name="links" defaultValue={lines.links} />
      </p>
    </ActionForm>
  );
}

/** The commitments the reader may propose on the request as it is now, each a form whose proposal waits for its confirmations. */
function CommitmentsSection({ data, parts, csrf }: { data: RequestPageData; parts: Parts; csrf: string }): ReactNode {
  const { request, packet, teams } = data;
  const { key, state } = request;
  const forms: ReactNode[] = [];
  if (!TERMINAL.has(state)) {
    if (parts.targetTeam) {
      forms.push(<ActionForm key="decline" requestKey={key} action="decline" csrf={csrf} button="Decline" />);
      if (DONE_FROM.has(state)) forms.push(<ActionForm key="done" requestKey={key} action="done" csrf={csrf} button="Mark done" />);
      const others = teams.filter((team) => team.key !== request.targetTeam.key);
      if (others.length > 0) {
        forms.push(
          <ActionForm key="reassign" requestKey={key} action="reassign" csrf={csrf} button="Reassign">
            <p>
              <label htmlFor="team">Team to reassign it to</label>{" "}
              <select id="team" name="team">
                {others.map((team) => (
                  <option key={team.key} value={team.key}>
                    {team.key}
                  </option>
                ))}
              </select>
            </p>
          </ActionForm>,
        );
      }
    }
    if (parts.requesterSide) forms.push(<ActionForm key="withdraw" requestKey={key} action="withdraw" csrf={csrf} button="Withdraw" />);
    if (parts.targetTeam || parts.requesterSide) {
      forms.push(
        <ActionForm key="due_date" requestKey={key} action="due_date" csrf={csrf} button="Propose the due date">
          <input type="hidden" name="revision" value={String(packet.revision)} />
          <p>
            <label htmlFor="dueDate">Due date</label> <input type="date" id="dueDate" name="dueDate" required />
          </p>
        </ActionForm>,
      );
      if (packet.packet.due_date !== undefined) {
        forms.push(
          <ActionForm key="remove_due_date" requestKey={key} action="remove_due_date" csrf={csrf} button="Propose removing the due date">
            <input type="hidden" name="revision" value={String(packet.revision)} />
          </ActionForm>,
        );
      }
    }
    if (parts.requesterSide) forms.push(<PacketForm key="change_packet" request={request} packet={packet} csrf={csrf} />);
  }
  return (
    <Section id="commitments" title="Commitments">
      <p>
        A commitment waits as a proposal until the people it needs confirm it on its confirm page. A due date, and a change of the need or the
        acceptance criteria while the request is claimed, need a confirmation from each side.
      </p>
      {forms.length === 0 ? <p>There is no commitment for you to propose on it now.</p> : forms}
    </Section>
  );
}

/** The page of a request, whose forms carry the reader's CSRF token. */
export function RequestPage({ data, csrf }: { data: RequestPageData; csrf: string }): ReactNode {
  const { request, packet, proposals } = data;
  const parts = partsOf(data);
  return (
    <main>
      <h1>{`${request.key}: ${request.untrusted.title}`}</h1>
      {request.needsHuman ? <WaitsForAPerson request={request} /> : null}
      <Summary request={request} />
      <ActionsSection request={request} parts={parts} csrf={csrf} />
      <CommitmentsSection data={data} parts={parts} csrf={csrf} />
      <PacketSection packet={packet} />
      <ThreadSection messages={request.messages} />
      <PostSection request={request} parts={parts} csrf={csrf} />
      <ProposalsSection proposals={proposals} />
    </main>
  );
}
