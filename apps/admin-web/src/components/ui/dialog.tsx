import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/utils/cn";
import { IconButton } from "./button";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out" />
    <DialogPrimitive.Content data-slot="dialog-content" className={cn("fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-auto rounded-lg border border-border bg-background p-6 shadow-xl", className)} {...props}>{children}</DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}

export function Modal({ open, title, children, onClose, footer, className }: { open: boolean; title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; className?: string }) {
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className={cn("modal p-0", className)} aria-describedby={undefined}>
      <header className="modal-header flex items-center justify-between gap-4 border-b border-border px-5 py-4"><DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title><DialogPrimitive.Close asChild><IconButton label="关闭"><X size={18} /></IconButton></DialogPrimitive.Close></header>
      <div className="modal-content px-5 py-4">{children}</div>
      {footer && <footer className="modal-footer flex justify-end gap-2 border-t border-border px-5 py-4">{footer}</footer>}
    </DialogContent>
  </Dialog>;
}
