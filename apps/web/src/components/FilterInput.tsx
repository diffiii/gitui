import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

/** A list's filter box: a search field that grows to fill its row. */
export function FilterInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative flex-1">
      <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 pointer-coarse:h-10"
      />
    </div>
  );
}
