import type { ReactNode } from "react";

type SequenceCellProps = {
  value: number | string;
  selection?: ReactNode;
  className?: string;
};

type SequenceHeaderProps = {
  selection?: ReactNode;
  className?: string;
};

export function SequenceCell({ value, selection, className = "" }: SequenceCellProps) {
  return (
    <span className={`sequence-cell${selection ? " sequence-cell-selectable" : ""}${className ? ` ${className}` : ""}`}>
      {selection}
      <span className="sequence-number">{value}</span>
    </span>
  );
}

export function SequenceHeader({ selection, className = "" }: SequenceHeaderProps) {
  return (
    <span className={`sequence-cell sequence-cell-header${selection ? " sequence-cell-selectable" : ""}${className ? ` ${className}` : ""}`}>
      {selection}
      <span>序号</span>
    </span>
  );
}
