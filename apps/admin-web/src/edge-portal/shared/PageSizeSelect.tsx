export function PageSizeSelect({ value, onChange, options = [10, 20, 50, 100], disabled = false }: {
  value: number;
  onChange: (value: number) => void;
  options?: number[];
  disabled?: boolean;
}) {
  return <label className="table-page-size">
    每页
    <select aria-label="每页显示条数" value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))}>
      {options.map((option) => <option value={option} key={option}>{option}</option>)}
    </select>
    条
  </label>;
}
