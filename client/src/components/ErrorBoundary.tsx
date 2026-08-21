import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Catches a crash while rendering and shows a recovery screen instead.
 *
 * Without this, React unmounts the entire tree when any component throws and
 * the user is left staring at a blank white page with nothing to click.
 *
 * The message is deliberately plain and the details are deliberately absent:
 * a stack trace tells SPO staff nothing they can act on, and can expose
 * internal structure. The real error goes to the browser console.
 */

interface Props {
  children: ReactNode;
  /**
   * "page" fills the screen and is used at the root. "inline" fits inside the
   * existing layout, so a crash in one page keeps the sidebar and header
   * usable and the user can navigate somewhere else.
   */
  variant?: "page" | "inline";
  /**
   * Change this to clear a caught error -- passing the current route means a
   * crashed page recovers as soon as the user navigates away, instead of the
   * fallback sticking around for the rest of the session.
   */
  resetKey?: string;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ui] Render error:", error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const isPage = this.props.variant !== "inline";

    return (
      <div
        className={
          isPage
            ? "flex min-h-screen items-center justify-center bg-background p-6"
            : "flex flex-1 items-center justify-center p-6"
        }
        role="alert"
        data-testid="error-boundary"
      >
        <div className="max-w-md text-center">
          <AlertTriangle className="mx-auto mb-4 h-10 w-10 text-destructive" />
          <h1 className="text-lg font-semibold text-foreground">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Please refresh the page. If the problem continues, contact support.
          </p>
          <Button
            className="mt-6"
            onClick={this.handleReload}
            data-testid="button-error-reload"
          >
            Refresh the page
          </Button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
