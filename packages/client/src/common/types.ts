import { NotificationSeverity } from './enum';

export type TToastAction = {
  label: string;
  onClick: () => void;
};

export type TShowToast = {
  message: string;
  /** Optional button shown inside the toast (e.g. "Report an issue"). */
  action?: TToastAction;
  severity?: NotificationSeverity;
  showIcon?: boolean;
  duration?: number;
  status?: 'error' | 'success' | 'warning' | 'info';
};

export type Option = Record<string, unknown> & {
  label?: string;
  value: string | number | null;
};

export type OptionWithIcon = Option & { icon?: React.ReactNode };
export type DropdownValueSetter = (value: string | Option | OptionWithIcon) => void;
export type MentionOption = OptionWithIcon & {
  type: string;
  value: string;
  description?: string;
};

export interface SelectedValues {
  endpoint: string | null;
  model: string | null;
  modelSpec: string | null;
}
