import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/utils/cn";

export const buttonVariants = cva(
  "button inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "button-primary bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "button-secondary border border-border bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "button-ghost border border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        danger: "button-danger border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
        outline: "border border-border bg-background hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "size-9 p-0"
      }
    },
    defaultVariants: { variant: "primary", size: "default" }
  }
);

export function Button({ className, variant, size, asChild = false, type = "button", ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" type={type} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export function IconButton({ label, className, ...props }: ComponentProps<"button"> & { label: string }) {
  return <button type="button" data-slot="icon-button" className={cn("icon-button inline-grid size-9 shrink-0 place-items-center rounded-md border border-border bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground", className)} aria-label={label} title={label} {...props} />;
}
