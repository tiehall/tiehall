import type { ReactNode } from "react";
import type { RequestPageData } from "@tiehall/commands/web";

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
    </>
  );
}

/** The notice of a request agents flagged needs_human. */
function WaitsForAPerson({ request }: { request: Request }): ReactNode {
  return (
    <p role="alert">
      <strong>{`${request.key} waits for a person: agents made so many writes on it that their writes are refused until a member posts a message on it here.`}</strong>
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

/** The page of a request. */
export function RequestPage({ data }: { data: RequestPageData }): ReactNode {
  const { request, packet, proposals } = data;
  return (
    <main>
      <h1>{`${request.key}: ${request.untrusted.title}`}</h1>
      {request.needsHuman ? <WaitsForAPerson request={request} /> : null}
      <Summary request={request} />
      <PacketSection packet={packet} />
      <ThreadSection messages={request.messages} />
      <ProposalsSection proposals={proposals} />
    </main>
  );
}
