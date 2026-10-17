import { format } from 'date-fns';

export function greet(name: string, at: Date = new Date()): string {
  return `Hello ${name}, it is ${format(at, 'HH:mm')}`;
}
