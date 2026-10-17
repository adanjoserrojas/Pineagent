import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type Session = {
  displayName: string;
  getToken: () => Promise<string>;
  signOut: () => void;
};

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside AuthGate");
  return s;
}

const env = import.meta.env;
const auth0Configured = Boolean(env.VITE_AUTH0_DOMAIN && env.VITE_AUTH0_CLIENT_ID);

// Auth0 when configured; otherwise a dev identity from ?as=<name> that only the mock server accepts.
export function AuthGate({ children }: { children: ReactNode }) {
  if (!auth0Configured) return <DevSession>{children}</DevSession>;
  return (
    <Auth0Provider
      domain={env.VITE_AUTH0_DOMAIN}
      clientId={env.VITE_AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin + window.location.pathname,
        audience: env.VITE_AUTH0_AUDIENCE || undefined,
        connection: "github",
      }}
    >
      <Auth0Session>{children}</Auth0Session>
    </Auth0Provider>
  );
}

function DevSession({ children }: { children: ReactNode }) {
  const name = new URLSearchParams(window.location.search).get("as") ?? "alice";
  const session = useMemo<Session>(
    () => ({ displayName: name, getToken: async () => `dev:${name}`, signOut: () => {} }),
    [name],
  );
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

function Auth0Session({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, error, user, loginWithRedirect, getAccessTokenSilently, logout } = useAuth0();
  const session = useMemo<Session | null>(
    () =>
      isAuthenticated
        ? {
            displayName: user?.nickname ?? user?.name ?? "you",
            getToken: async () => {
              const token = await getAccessTokenSilently();
              if (!token) throw new Error("Auth0 returned no access token");
              return token;
            },
            signOut: () => logout({ logoutParams: { returnTo: window.location.origin } }),
          }
        : null,
    [isAuthenticated, user, getAccessTokenSilently, logout],
  );

  if (isLoading) return <p className="center-note">Signing in…</p>;
  if (!session) return <SignIn error={error?.message} onSignIn={() => loginWithRedirect()} />;
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

function SignIn({ error, onSignIn }: { error?: string; onSignIn: () => void }) {
  return (
    <main className="signin">
      <h1>Pineagent</h1>
      <p>Sign in with GitHub to open a repository you collaborate on.</p>
      <button type="button" className="btn-primary" onClick={onSignIn}>
        Continue with GitHub
      </button>
      {error && <p role="alert" className="signin-error">{error}</p>}
    </main>
  );
}
