import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils";

const alertVariants = cva(
  "relative grid w-full grid-cols-[calc(var(--spacing)*4)_1fr] items-start gap-x-3 gap-y-0.5 rounded-lg border px-4 py-3 text-sm [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "border-destructive/25 bg-destructive/10 text-destructive *:data-[slot=alert-description]:text-destructive/90 [&>svg]:text-current",
        success:
          "border-success/30 bg-success/15 text-success-foreground *:data-[slot=alert-description]:text-success-foreground/90 [&>svg]:text-current",
        warning:
          "border-warning/30 bg-warning/20 text-warning-foreground *:data-[slot=alert-description]:text-warning-foreground/90 [&>svg]:text-current",
        info: "border-primary/30 bg-primary/10 text-primary *:data-[slot=alert-description]:text-primary/90 [&>svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "destructive",
    },
  },
);

const variantIcons: Record<
  NonNullable<VariantProps<typeof alertVariants>["variant"]>,
  React.ComponentType<{ className?: string }>
> = {
  default: InfoIcon,
  destructive: CircleAlertIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  info: InfoIcon,
};

function Alert({
  className,
  variant = "destructive",
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  const Icon = variantIcons[variant ?? "destructive"];

  // Check if children already includes a slot component (AlertTitle/AlertDescription)
  // or a manually provided icon. If just raw text/elements, wrap them properly.
  const hasSlottedContent = React.Children.toArray(children).some(
    (child) =>
      React.isValidElement(child) &&
      (child.type === AlertTitle ||
        child.type === AlertDescription ||
        (typeof child.type === "string" && child.type === "svg") ||
        (typeof child.type === "function" && "displayName" in child.type)),
  );

  return (
    <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props}>
      <Icon aria-hidden />
      {hasSlottedContent ? children : <span className="col-start-2 text-sm leading-relaxed">{children}</span>}
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm leading-relaxed text-muted-foreground [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle, alertVariants };
