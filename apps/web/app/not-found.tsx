import { FocusedShell } from "../lib/shell.tsx";

// The page for a path no route serves (web-ui: The page shell and its
// navigation; web-ui: The content security policy of each kind of page;
// design.md, Design: The content security policy of each kind of page; D57
// (4), (9)), in the focused shell, in place of the framework's default, which
// carries an inline style element and style attributes that the framework
// pages' policy would block. The root layout wraps it, with the head and the
// footer.
export default function NotFound() {
  return (
    <FocusedShell>
      <title>No such page · Tiehall</title>
      <div className="refusal">
        <p className="status">404</p>
        <h1>No such page</h1>
        <p className="lead">Tiehall has no page at this address. A request&apos;s page is at its key, such as /FE-142, and a team&apos;s at its key, such as /FE.</p>
        <p>
          <a className="button" href="/">
            Go to Tiehall&apos;s home page
          </a>
        </p>
      </div>
    </FocusedShell>
  );
}
