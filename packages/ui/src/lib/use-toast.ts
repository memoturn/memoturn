import { toast as sonnerToast } from "sonner";

type ToastInput = string | { title: string; description?: string };

function normalize(input: ToastInput): { title: string; description?: string } {
  return typeof input === "string" ? { title: input } : input;
}

const toast = {
  success(input: ToastInput) {
    const { title, description } = normalize(input);
    return sonnerToast.success(title, description ? { description } : undefined);
  },
  error(input: ToastInput) {
    const { title, description } = normalize(input);
    return sonnerToast.error(title, description ? { description } : undefined);
  },
  info(input: ToastInput) {
    const { title, description } = normalize(input);
    return sonnerToast(title, description ? { description } : undefined);
  },
  dismiss(id?: string | number) {
    return sonnerToast.dismiss(id);
  },
};

function useToast() {
  return toast;
}

export { toast, useToast };
