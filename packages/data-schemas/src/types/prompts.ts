import type { Document, Types } from 'mongoose';

export interface IPrompt extends Document {
  groupId: Types.ObjectId;
  author: Types.ObjectId;
  prompt: string;
  type: 'text' | 'chat';
  createdAt?: Date;
  updatedAt?: Date;
  /** The person who owned this before they left the institution and it stayed. */
  transferredFrom?: Types.ObjectId | null;
  tenantId?: string;
}

export interface IPromptGroup {
  name: string;
  numberOfGenerations: number;
  oneliner: string;
  category: string;
  productionId: Types.ObjectId;
  author: Types.ObjectId;
  authorName: string;
  command?: string;
  createdAt?: Date;
  updatedAt?: Date;
  isPublic?: boolean;
  /** The person who owned this before they left the institution and it stayed. */
  transferredFrom?: Types.ObjectId | null;
  tenantId?: string;
}

export interface IPromptGroupDocument extends IPromptGroup, Document {}
