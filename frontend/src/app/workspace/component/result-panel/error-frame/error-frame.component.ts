/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { ChangeDetectorRef, Component, Input, OnInit } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { ExecuteWorkflowService } from "../../../service/execute-workflow/execute-workflow.service";
import { UntilDestroy } from "@ngneat/until-destroy";
import { WorkflowFatalError } from "../../../types/workflow-websocket.interface";
import { WorkflowActionService } from "../../../service/workflow-graph/model/workflow-action.service";
import { WorkflowCompilingService } from "../../../service/compile-workflow/workflow-compiling.service";
import { NgIf, NgFor, KeyValuePipe, JsonPipe } from "@angular/common";
import { NzCollapseComponent, NzCollapsePanelComponent } from "ng-zorro-antd/collapse";
import { ɵNzTransitionPatchDirective } from "ng-zorro-antd/core/transition-patch";
import { NzIconDirective } from "ng-zorro-antd/icon";
import { NzButtonComponent } from "ng-zorro-antd/button";
import { NzWaveDirective } from "ng-zorro-antd/core/wave";
import { NzSpinComponent } from "ng-zorro-antd/spin";
import { NzAlertComponent } from "ng-zorro-antd/alert";
import { NotificationService } from "../../../../common/service/notification/notification.service";

interface FixResult {
  explanation: string;
  fix: Record<string, any> | null;
}

interface FixState {
  loading: boolean;
  result?: FixResult;
  error?: string;
}

@UntilDestroy()
@Component({
  selector: "texera-error-frame",
  templateUrl: "./error-frame.component.html",
  styleUrls: ["./error-frame.component.scss"],
  imports: [
    NgIf,
    NgFor,
    NzCollapseComponent,
    NzCollapsePanelComponent,
    ɵNzTransitionPatchDirective,
    NzIconDirective,
    NzButtonComponent,
    NzWaveDirective,
    NzSpinComponent,
    NzAlertComponent,
    KeyValuePipe,
    JsonPipe,
  ],
})
export class ErrorFrameComponent implements OnInit {
  @Input() operatorId?: string;

  categoryToErrorMapping: ReadonlyMap<string, ReadonlyArray<WorkflowFatalError>> = new Map();

  // keyed by error.operatorId + error.message
  fixStates: Map<string, FixState> = new Map();

  constructor(
    private executeWorkflowService: ExecuteWorkflowService,
    private workflowActionService: WorkflowActionService,
    private workflowCompilingService: WorkflowCompilingService,
    private http: HttpClient,
    private notificationService: NotificationService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.renderError();
  }

  onClickGotoButton(target: string) {
    this.workflowActionService.highlightOperators(false, target);
  }

  renderError(): void {
    let errorMessages = this.executeWorkflowService.getErrorMessages();
    const compilationErrorMap = this.workflowCompilingService.getWorkflowCompilationErrors();
    errorMessages = errorMessages.concat(Object.values(compilationErrorMap));
    if (this.operatorId) {
      errorMessages = errorMessages.filter(err => err.operatorId === this.operatorId);
    }
    this.categoryToErrorMapping = errorMessages.reduce((acc, obj) => {
      const key = obj.type.name;
      if (!acc.has(key)) {
        acc.set(key, []);
      }
      acc.get(key)!.push(obj);
      return acc;
    }, new Map<string, WorkflowFatalError[]>());
  }

  fixKey(error: WorkflowFatalError): string {
    return `${error.operatorId}::${error.message}`;
  }

  getFixState(error: WorkflowFatalError): FixState | undefined {
    return this.fixStates.get(this.fixKey(error));
  }

  fixWithAI(error: WorkflowFatalError): void {
    const key = this.fixKey(error);
    if (!error.operatorId || error.operatorId === "unknown operator") return;

    let operator;
    try {
      operator = this.workflowActionService.getTexeraGraph().getOperator(error.operatorId);
    } catch {
      this.notificationService.error("Cannot find operator to fix.");
      return;
    }

    this.fixStates.set(key, { loading: true });
    this.cdr.markForCheck();

    this.http
      .post<FixResult>("/api/fix-operator", {
        error: `${error.message}\n${error.details}`,
        operatorType: operator.operatorType,
        operatorProperties: operator.operatorProperties,
      })
      .subscribe({
        next: result => {
          this.fixStates.set(key, { loading: false, result });
          this.cdr.markForCheck();
        },
        error: err => {
          this.fixStates.set(key, { loading: false, error: err.message ?? "Failed to get fix suggestion." });
          this.cdr.markForCheck();
        },
      });
  }

  applyFix(error: WorkflowFatalError): void {
    const state = this.getFixState(error);
    if (!state?.result?.fix || !error.operatorId) return;

    let operator;
    try {
      operator = this.workflowActionService.getTexeraGraph().getOperator(error.operatorId);
    } catch {
      this.notificationService.error("Cannot find operator to apply fix.");
      return;
    }

    const updatedProperties = { ...operator.operatorProperties, ...state.result.fix };
    this.workflowActionService.setOperatorProperty(error.operatorId, updatedProperties);
    this.notificationService.success("Fix applied. Re-run the workflow to verify.");

    this.fixStates.delete(this.fixKey(error));
    this.cdr.markForCheck();
  }
}
