/** User data transfer object — safe to send to clients (no tokens) */
export interface UserDTO {
  id: number;
  email: string;
  name: string;
  picture: string | null;
  createdAt: string;
}
