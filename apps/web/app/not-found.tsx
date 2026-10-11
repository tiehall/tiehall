// The page for a path no route serves (web-ui: The page shell and its
// navigation; web-ui: The content security policy of each kind of page;
// design.md, Design: The content security policy of each kind of page; D57
// (9)), in place of the framework's default, which carries an inline style
// element and style attributes that the framework pages' policy would block.
// The root layout wraps it, with the page's footer.
export default function NotFound() {
  return (
    <main id="content" className="focused">
      <h1>No such page</h1>
      <p>Tiehall has no page at this address. A request&apos;s page is at its key, such as /FE-142, and a team&apos;s at its key, such as /FE.</p>
      <p>
        <a href="/">Go to Tiehall&apos;s home page</a>
      </p>
    </main>
  );
}
