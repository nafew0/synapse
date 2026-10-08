import { useMutation } from '@tanstack/react-query';
import { MutationKeys, dataService } from 'librechat-data-provider';
import type { UseMutationOptions } from '@tanstack/react-query';
import type { TIssueReportRequest } from 'librechat-data-provider';

export const useCreateIssueReportMutation = (
  options?: UseMutationOptions<void, Error, TIssueReportRequest>,
) =>
  useMutation<void, Error, TIssueReportRequest>(
    [MutationKeys.createIssueReport],
    (payload: TIssueReportRequest) => dataService.createIssueReport(payload),
    options,
  );
