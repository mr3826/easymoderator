/**
 * Authentication and User types
 */

export interface User {
  id: string;
  email: string;
  full_name: string;
  role?: string;
  phone?: string;
  profile_picture?: string;
}

export interface Shop {
  id: string;
  unique_code: string;
  shop_name?: string;
  role: 'owner' | 'admin' | 'staff';
  settings?: { 
    onboarding_completed?: boolean; 
    [key: string]: unknown 
  };
}

export interface AuthResponse {
  user: User;
  currentShop: Shop;
  allShops: Shop[];
  shop?: Shop;
  /** Present when the backend requires a second factor before issuing full tokens. */
  requires2fa?: boolean;
  /** Short-lived token exchanged at POST /auth/2fa/verify when requires2fa is true. */
  tempToken?: string;
}

export interface SigninRequest {
  email: string;
  password: string;
}

export interface SignupRequest {
  email: string;
  password: string;
  full_name: string;
  phone?: string;
  accepted_terms: true;
  /** Marketing acquisition attribution (bounded slugs, e.g. landing_zero). */
  source?: string;
  offer?: string;
}

export interface CreateShopRequest {
  shop_name?: string;
}

export interface PasswordResetRequest {
  email: string;
}

export interface PasswordUpdateRequest {
  token: string;
  password: string;
}
