{{/* Expand the name of the chart. */}}
{{- define "memoturn.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified app name. */}}
{{- define "memoturn.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "memoturn.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "memoturn.labels" -}}
helm.sh/chart: {{ include "memoturn.chart" . }}
{{ include "memoturn.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: memoturn
{{- end -}}

{{/* Selector labels (release-wide). */}}
{{- define "memoturn.selectorLabels" -}}
app.kubernetes.io/name: {{ include "memoturn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Service account name. */}}
{{- define "memoturn.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "memoturn.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Name of the Secret holding sensitive env (chart-managed or external). */}}
{{- define "memoturn.secretName" -}}
{{- if .Values.config.existingSecret -}}
{{- .Values.config.existingSecret -}}
{{- else -}}
{{- printf "%s-env" (include "memoturn.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Image reference for a component (api/worker/console). */}}
{{- define "memoturn.image" -}}
{{- $top := index . 0 -}}
{{- $component := index . 1 -}}
{{- $tag := default $top.Chart.AppVersion $top.Values.image.tag -}}
{{- printf "%s/%s/%s:%s" $top.Values.image.registry $top.Values.image.repository $component $tag -}}
{{- end -}}

{{/* envFrom shared by api + worker: chart Secret + ConfigMap + any extras. */}}
{{- define "memoturn.envFrom" -}}
- secretRef:
    name: {{ include "memoturn.secretName" . }}
- configMapRef:
    name: {{ include "memoturn.fullname" . }}-config
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end -}}
