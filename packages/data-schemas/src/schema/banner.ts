import { Schema } from 'mongoose';
import {
  bannerApps,
  bannerTypes,
  bannerCategories,
  bannerDisplayModes,
} from 'librechat-data-provider';
import type { IBanner } from '~/types/banner';

const bannerSchema: Schema<IBanner> = new Schema<IBanner>(
  {
    bannerId: {
      type: String,
      required: true,
    },
    app: {
      type: String,
      enum: bannerApps,
      default: 'chat',
    },
    title: {
      type: String,
    },
    message: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      enum: bannerCategories,
    },
    display: {
      type: String,
      enum: bannerDisplayModes,
    },
    linkLabel: {
      type: String,
    },
    linkUrl: {
      type: String,
    },
    displayFrom: {
      type: Date,
      required: true,
      default: Date.now,
    },
    displayTo: {
      type: Date,
    },
    type: {
      type: String,
      enum: bannerTypes,
      default: 'banner',
    },
    isPublic: {
      type: Boolean,
      default: false,
    },
    persistable: {
      type: Boolean,
      default: false,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

export default bannerSchema;
