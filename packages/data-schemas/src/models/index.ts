import {
  createModelPriceModel,
  createModelPriceVersionModel,
  createModelPriceChangeModel,
  createModelPriceSyncModel,
} from './modelPrice';
import {
  createUsageAccountModel,
  createUsagePackageModel,
  createUsagePricingModel,
} from './usagePackage';
import {
  createBdrenAllowanceModel,
  createBdrenEventModel,
  createBdrenUploadTicketModel,
} from './bdren';
import { createKbDocumentModel, createKbDocumentVersionModel, createKbIngestJobModel } from './kb';
import { createAgentTriggerLaneSequenceModel } from './triggerLaneSequence';
import { createInstitutionImportJobModel } from './institutionImportJob';
import { createAdminScopeAssignmentModel } from './adminScopeAssignment';
import { createSkillSyncCredentialModel } from './skillSyncCredential';
import { createAgentTriggerUserPurgeModel } from './triggerUserPurge';
import { createAgentTriggerDeliveryModel } from './triggerDelivery';
import { createInstitutionInviteModel } from './institutionInvite';
import { createUsageReservationModel } from './usageReservation';
import { createSkillSyncStatusModel } from './skillSyncStatus';
import { createConversationTagModel } from './conversationTag';
import { createTaskCostProfileModel } from './taskCostProfile';
import { createAgentCategoryModel } from './agentCategory';
import { createPlatformAdminModel } from './platformAdmin';
import { createCostSettingsModel } from './costSettings';
import { createUsageWarningModel } from './usageWarning';
import { createChatProjectModel } from './chatProject';
import { createAgentApiKeyModel } from './agentApiKey';
import { createTransactionModel } from './transaction';
import { createPromptGroupModel } from './promptGroup';
import { createSystemGrantModel } from './systemGrant';
import { createInstitutionModel } from './institution';
import { createUsagePolicyModel } from './usagePolicy';
import { createUsageBucketModel } from './usageBucket';
import { createPluginAuthModel } from './pluginAuth';
import { createSharedLinkModel } from './sharedLink';
import { createAccessRoleModel } from './accessRole';
import { createToolFavoriteModel } from './favorite';
import { createBannerViewModel } from './bannerView';
import { createUsageDailyModel } from './usageDaily';
import { createMCPServerModel } from './mcpServer';
import { createAssistantModel } from './assistant';
import { createSkillFileModel } from './skillFile';
import { createConversationModel } from './convo';
import { createToolCallModel } from './toolCall';
import { createAclEntryModel } from './aclEntry';
import { createAuditLogModel } from './auditLog';
import { createUsageJobModel } from './usageJob';
import { createSessionModel } from './session';
import { createBalanceModel } from './balance';
import { createMessageModel } from './message';
import { createActionModel } from './action';
import { createBannerModel } from './banner';
import { createPresetModel } from './preset';
import { createPromptModel } from './prompt';
import { createMemoryModel } from './memory';
import { createConfigModel } from './config';
import { createTokenModel } from './token';
import { createAgentModel } from './agent';
import { createSkillModel } from './skill';
import { createGroupModel } from './group';
import { createUserModel } from './user';
import { createRoleModel } from './role';
import { createFileModel } from './file';
import { createKeyModel } from './key';
import logger from '~/config/winston';

/**
 * Creates all database models for all collections
 */
export function createModels(mongoose: typeof import('mongoose')): {
  User: ReturnType<typeof createUserModel>;
  Token: ReturnType<typeof createTokenModel>;
  Session: ReturnType<typeof createSessionModel>;
  Balance: ReturnType<typeof createBalanceModel>;
  Conversation: ReturnType<typeof createConversationModel>;
  ChatProject: ReturnType<typeof createChatProjectModel>;
  KbDocument: ReturnType<typeof createKbDocumentModel>;
  KbDocumentVersion: ReturnType<typeof createKbDocumentVersionModel>;
  KbIngestJob: ReturnType<typeof createKbIngestJobModel>;
  Message: ReturnType<typeof createMessageModel>;
  Agent: ReturnType<typeof createAgentModel>;
  AgentApiKey: ReturnType<typeof createAgentApiKeyModel>;
  AgentCategory: ReturnType<typeof createAgentCategoryModel>;
  MCPServer: ReturnType<typeof createMCPServerModel>;
  Role: ReturnType<typeof createRoleModel>;
  Action: ReturnType<typeof createActionModel>;
  Assistant: ReturnType<typeof createAssistantModel>;
  File: ReturnType<typeof createFileModel>;
  Banner: ReturnType<typeof createBannerModel>;
  BannerView: ReturnType<typeof createBannerViewModel>;
  Key: ReturnType<typeof createKeyModel>;
  PluginAuth: ReturnType<typeof createPluginAuthModel>;
  Transaction: ReturnType<typeof createTransactionModel>;
  Preset: ReturnType<typeof createPresetModel>;
  Prompt: ReturnType<typeof createPromptModel>;
  PromptGroup: ReturnType<typeof createPromptGroupModel>;
  Skill: ReturnType<typeof createSkillModel>;
  SkillFile: ReturnType<typeof createSkillFileModel>;
  SkillSyncCredential: ReturnType<typeof createSkillSyncCredentialModel>;
  SkillSyncStatus: ReturnType<typeof createSkillSyncStatusModel>;
  ConversationTag: ReturnType<typeof createConversationTagModel>;
  SharedLink: ReturnType<typeof createSharedLinkModel>;
  ToolCall: ReturnType<typeof createToolCallModel>;
  MemoryEntry: ReturnType<typeof createMemoryModel>;
  ToolFavorite: ReturnType<typeof createToolFavoriteModel>;
  AccessRole: ReturnType<typeof createAccessRoleModel>;
  AclEntry: ReturnType<typeof createAclEntryModel>;
  SystemGrant: ReturnType<typeof createSystemGrantModel>;
  AuditLog: ReturnType<typeof createAuditLogModel>;
  Group: ReturnType<typeof createGroupModel>;
  Config: ReturnType<typeof createConfigModel>;
  Institution: ReturnType<typeof createInstitutionModel>;
  InstitutionImportJob: ReturnType<typeof createInstitutionImportJobModel>;
  InstitutionInvite: ReturnType<typeof createInstitutionInviteModel>;
  UsagePackage: ReturnType<typeof createUsagePackageModel>;
  UsagePricing: ReturnType<typeof createUsagePricingModel>;
  UsageAccount: ReturnType<typeof createUsageAccountModel>;
  PlatformAdmin: ReturnType<typeof createPlatformAdminModel>;
  UsagePolicy: ReturnType<typeof createUsagePolicyModel>;
  UsageBucket: ReturnType<typeof createUsageBucketModel>;
  UsageJob: ReturnType<typeof createUsageJobModel>;
  TaskCostProfile: ReturnType<typeof createTaskCostProfileModel>;
  ModelPrice: ReturnType<typeof createModelPriceModel>;
  ModelPriceVersion: ReturnType<typeof createModelPriceVersionModel>;
  ModelPriceChange: ReturnType<typeof createModelPriceChangeModel>;
  ModelPriceSync: ReturnType<typeof createModelPriceSyncModel>;
  CostSettings: ReturnType<typeof createCostSettingsModel>;
  UsageDaily: ReturnType<typeof createUsageDailyModel>;
  BdrenAllowance: ReturnType<typeof createBdrenAllowanceModel>;
  BdrenEvent: ReturnType<typeof createBdrenEventModel>;
  BdrenUploadTicket: ReturnType<typeof createBdrenUploadTicketModel>;
  UsageReservation: ReturnType<typeof createUsageReservationModel>;
  UsageWarning: ReturnType<typeof createUsageWarningModel>;
  AdminScopeAssignment: ReturnType<typeof createAdminScopeAssignmentModel>;
  AgentTriggerDelivery: ReturnType<typeof createAgentTriggerDeliveryModel>;
  AgentTriggerLaneSequence: ReturnType<typeof createAgentTriggerLaneSequenceModel>;
  AgentTriggerUserPurge: ReturnType<typeof createAgentTriggerUserPurgeModel>;
} {
  const models = {
    User: createUserModel(mongoose),
    Token: createTokenModel(mongoose),
    Session: createSessionModel(mongoose),
    Balance: createBalanceModel(mongoose),
    Conversation: createConversationModel(mongoose),
    ChatProject: createChatProjectModel(mongoose),
    KbDocument: createKbDocumentModel(mongoose),
    KbDocumentVersion: createKbDocumentVersionModel(mongoose),
    KbIngestJob: createKbIngestJobModel(mongoose),
    Message: createMessageModel(mongoose),
    Agent: createAgentModel(mongoose),
    AgentApiKey: createAgentApiKeyModel(mongoose),
    AgentCategory: createAgentCategoryModel(mongoose),
    MCPServer: createMCPServerModel(mongoose),
    Role: createRoleModel(mongoose),
    Action: createActionModel(mongoose),
    Assistant: createAssistantModel(mongoose),
    File: createFileModel(mongoose),
    Banner: createBannerModel(mongoose),
    BannerView: createBannerViewModel(mongoose),
    Key: createKeyModel(mongoose),
    PluginAuth: createPluginAuthModel(mongoose),
    Transaction: createTransactionModel(mongoose),
    Preset: createPresetModel(mongoose),
    Prompt: createPromptModel(mongoose),
    PromptGroup: createPromptGroupModel(mongoose),
    Skill: createSkillModel(mongoose),
    SkillFile: createSkillFileModel(mongoose),
    SkillSyncCredential: createSkillSyncCredentialModel(mongoose),
    SkillSyncStatus: createSkillSyncStatusModel(mongoose),
    ConversationTag: createConversationTagModel(mongoose),
    SharedLink: createSharedLinkModel(mongoose),
    ToolCall: createToolCallModel(mongoose),
    MemoryEntry: createMemoryModel(mongoose),
    ToolFavorite: createToolFavoriteModel(mongoose),
    AccessRole: createAccessRoleModel(mongoose),
    AclEntry: createAclEntryModel(mongoose),
    SystemGrant: createSystemGrantModel(mongoose),
    AuditLog: createAuditLogModel(mongoose),
    Group: createGroupModel(mongoose),
    Config: createConfigModel(mongoose),
    Institution: createInstitutionModel(mongoose),
    InstitutionImportJob: createInstitutionImportJobModel(mongoose),
    InstitutionInvite: createInstitutionInviteModel(mongoose),
    UsagePackage: createUsagePackageModel(mongoose),
    UsagePricing: createUsagePricingModel(mongoose),
    UsageAccount: createUsageAccountModel(mongoose),
    PlatformAdmin: createPlatformAdminModel(mongoose),
    UsagePolicy: createUsagePolicyModel(mongoose),
    UsageBucket: createUsageBucketModel(mongoose),
    UsageJob: createUsageJobModel(mongoose),
    TaskCostProfile: createTaskCostProfileModel(mongoose),
    ModelPrice: createModelPriceModel(mongoose),
    ModelPriceVersion: createModelPriceVersionModel(mongoose),
    ModelPriceChange: createModelPriceChangeModel(mongoose),
    ModelPriceSync: createModelPriceSyncModel(mongoose),
    CostSettings: createCostSettingsModel(mongoose),
    UsageDaily: createUsageDailyModel(mongoose),
    BdrenAllowance: createBdrenAllowanceModel(mongoose),
    BdrenEvent: createBdrenEventModel(mongoose),
    BdrenUploadTicket: createBdrenUploadTicketModel(mongoose),
    UsageReservation: createUsageReservationModel(mongoose),
    UsageWarning: createUsageWarningModel(mongoose),
    AdminScopeAssignment: createAdminScopeAssignmentModel(mongoose),
    AgentTriggerDelivery: createAgentTriggerDeliveryModel(mongoose),
    AgentTriggerLaneSequence: createAgentTriggerLaneSequenceModel(mongoose),
    AgentTriggerUserPurge: createAgentTriggerUserPurgeModel(mongoose),
  };
  /**
   * Background index builds fail silently unless an 'index' listener is
   * attached (e.g. Amazon DocumentDB <5.0 rejecting partialFilterExpression),
   * leaving unique constraints unenforced with no trace in the logs.
   */
  for (const model of Object.values(models)) {
    if (model.listenerCount('index') === 0) {
      model.on('index', (error?: Error) => {
        if (error) {
          logger.error(`Index build failed for "${model.modelName}": ${error.message}`);
        }
      });
    }
  }
  return models;
}
