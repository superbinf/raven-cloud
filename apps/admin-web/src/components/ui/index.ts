export { Badge, RiskBadge, StatusDot, Tag } from "./badge";
export { Button, IconButton, buttonVariants } from "./button";
export { Card, CardContent, CardHeader, Panel } from "./card";
export { Dialog, DialogClose, DialogContent, DialogTrigger, Modal } from "./dialog";
export { EmptyState } from "./empty-state";
export { Input } from "./input";
export { cn } from "@/utils/cn";

// Authentication and platform-level guards stay shared across Cloud and Edge.
// Business pages import through this local boundary so the app no longer couples
// directly to the monorepo UI package.
export {
  CaptchaField,
  GlobalErrorBoundary,
  PasswordInput,
  PlatformLoading,
  ThemeSwitcher,
  initializeUiTheme,
  useLoginCaptcha,
  type CaptchaChallenge
} from "@sentinel/ui";
