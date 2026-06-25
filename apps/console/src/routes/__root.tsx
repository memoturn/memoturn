import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({ component: RootComponent });

function RootComponent() {
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          memoturn
        </Link>
        <nav>
          <Link to="/dashboard">Dashboard</Link>
          <Link to="/traces">Traces</Link>
          <Link to="/prompts">Prompts</Link>
          <Link to="/datasets">Datasets</Link>
        </nav>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}
