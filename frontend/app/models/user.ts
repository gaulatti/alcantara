export interface User {
  id: string;
  principalId?: string | null;
  email: string;
  name?: string;
  picture?: string;
  role?: string;
}
