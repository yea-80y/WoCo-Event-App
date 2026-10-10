// ---------------------------------------------------------------------------
// Order form schema
// ---------------------------------------------------------------------------

/** Supported order form field types */
export type OrderFieldType =
  | "text"
  | "email"
  | "tel"
  | "textarea"
  | "select"
  | "checkbox";

/**
 * Schema for a single field in an event's order form.
 * Organizers configure these at event creation time.
 * The embed widget and main app render them dynamically.
 */
export interface OrderField {
  /** Stable identifier used as the key in submitted form data */
  id: string;
  /** Input type — determines the rendered control */
  type: OrderFieldType;
  /** Human-readable label shown above the input */
  label: string;
  /** Whether the field must be filled before submission */
  required: boolean;
  /** Placeholder text inside the input */
  placeholder?: string;
  /** Options list — only used when type is "select" */
  options?: string[];
  /** Maximum character length — for "text" and "textarea" */
  maxLength?: number;
}
