package sut

import (
	"math"
	"strconv"
)

// Request-body validation, mirroring packages/app/src/petstore/store.ts.
//
// The error strings are part of the contract: the load generator sends a
// deliberately invalid slice of traffic and the run report scores whether the
// SUT rejected it, so "rejected with a 4xx and this reason" is an observable the
// tests compare. Keep the wording in step with the TS petstore.
//
// Values arrive as float64 because that is what a JSON number is in both
// runtimes — JavaScript has no integer type, so reproducing its checks
// (Number.isInteger, Number.isSafeInteger) on float64 is exact rather than
// approximate.

const (
	maxName = 200
	maxDesc = 4000
)

type NewPetInput struct {
	Name        string
	Status      *string
	Category    *IDName
	Tags        []IDName
	PhotoURLs   []string
	Description *string
}

type UpdatePetInput struct {
	Name        *string
	Status      *string
	Description *string
}

func isInteger(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0) && f == math.Trunc(f)
}

func isSafeInteger(f float64) bool {
	return isInteger(f) && math.Abs(f) <= 9007199254740991
}

// asObject reports whether v is a JSON object — not null, not an array.
func asObject(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok && m != nil
}

func validateIDName(v any, label string) (IDName, string) {
	m, ok := asObject(v)
	if !ok {
		return IDName{}, label + " must be an object"
	}
	idRaw, hasID := m["id"].(float64)
	if !hasID || !isInteger(idRaw) || idRaw < 0 {
		return IDName{}, label + ".id must be a non-negative integer"
	}
	name, hasName := m["name"].(string)
	if !hasName || len([]rune(name)) > 100 {
		return IDName{}, label + ".name must be a string of at most 100 characters"
	}
	return IDName{ID: int64(idRaw), Name: name}, ""
}

// ValidateNewPet checks a POST /api/pets body against the published NewPet
// schema. The second return is an empty string on success.
func ValidateNewPet(body any) (NewPetInput, string) {
	m, ok := asObject(body)
	if !ok {
		return NewPetInput{}, "body must be a JSON object"
	}

	name, hasName := m["name"].(string)
	if !hasName || len([]rune(name)) == 0 || len([]rune(name)) > maxName {
		return NewPetInput{}, "name is required and must be a string of 1-" + strconv.Itoa(maxName) + " characters"
	}
	out := NewPetInput{Name: name}

	if raw, present := m["status"]; present {
		s, isStr := raw.(string)
		if !isStr || !IsPetStatus(s) {
			return NewPetInput{}, "status must be one of " + statusList()
		}
		out.Status = &s
	}

	if raw, present := m["category"]; present {
		c, err := validateIDName(raw, "category")
		if err != "" {
			return NewPetInput{}, err
		}
		out.Category = &c
	}

	if raw, present := m["tags"]; present {
		arr, isArr := raw.([]any)
		if !isArr || len(arr) > 20 {
			return NewPetInput{}, "tags must be an array of at most 20 entries"
		}
		parsed := make([]IDName, 0, len(arr))
		for _, t := range arr {
			v, err := validateIDName(t, "tags[]")
			if err != "" {
				return NewPetInput{}, err
			}
			parsed = append(parsed, v)
		}
		out.Tags = parsed
	}

	if raw, present := m["photoUrls"]; present {
		arr, isArr := raw.([]any)
		if !isArr || len(arr) > 10 {
			return NewPetInput{}, "photoUrls must be an array of at most 10 strings"
		}
		urls := make([]string, 0, len(arr))
		for _, u := range arr {
			s, isStr := u.(string)
			if !isStr {
				return NewPetInput{}, "photoUrls must be an array of at most 10 strings"
			}
			urls = append(urls, s)
		}
		out.PhotoURLs = urls
	}

	if raw, present := m["description"]; present {
		d, isStr := raw.(string)
		if !isStr || len([]rune(d)) > maxDesc {
			return NewPetInput{}, "description must be a string of at most " + strconv.Itoa(maxDesc) + " characters"
		}
		out.Description = &d
	}

	return out, ""
}

// ValidateUpdatePet checks a PUT /api/pets/{petId} body against UpdatePet.
func ValidateUpdatePet(body any) (UpdatePetInput, string) {
	m, ok := asObject(body)
	if !ok {
		return UpdatePetInput{}, "body must be a JSON object"
	}
	var out UpdatePetInput
	set := 0

	if raw, present := m["name"]; present {
		n, isStr := raw.(string)
		if !isStr || len([]rune(n)) == 0 || len([]rune(n)) > maxName {
			return UpdatePetInput{}, "name must be a string of 1-" + strconv.Itoa(maxName) + " characters"
		}
		out.Name = &n
		set++
	}
	if raw, present := m["status"]; present {
		s, isStr := raw.(string)
		if !isStr || !IsPetStatus(s) {
			return UpdatePetInput{}, "status must be one of " + statusList()
		}
		out.Status = &s
		set++
	}
	if raw, present := m["description"]; present {
		d, isStr := raw.(string)
		if !isStr || len([]rune(d)) > maxDesc {
			return UpdatePetInput{}, "description must be a string of at most " + strconv.Itoa(maxDesc) + " characters"
		}
		out.Description = &d
		set++
	}
	if set == 0 {
		return UpdatePetInput{}, "body must set at least one of name, status, description"
	}
	return out, ""
}

// ValidateOrder checks a POST /api/store/order body. Returns (petId, quantity)
// and an empty error string on success.
func ValidateOrder(body any) (int64, int, string) {
	m, ok := asObject(body)
	if !ok {
		// the TS route defaults a missing body to {} and then fails on petId,
		// so the reported reason is the same either way
		m = map[string]any{}
	}
	petRaw, isNum := m["petId"].(float64)
	if !isNum || !isSafeInteger(petRaw) || petRaw < 1 {
		return 0, 0, "petId is required and must be a positive integer"
	}
	quantity := 1
	if raw, present := m["quantity"]; present {
		q, isQNum := raw.(float64)
		if !isQNum || !isInteger(q) || q < 1 || q > 100 {
			return 0, 0, "quantity must be an integer between 1 and 100"
		}
		quantity = int(q)
	}
	return int64(petRaw), quantity, ""
}

// PathInt parses a path parameter that must be a positive integer.
func PathInt(raw string) (int64, bool) {
	if raw == "" || !allDigits(raw) {
		return 0, false
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 1 || !isSafeInteger(float64(n)) {
		return 0, false
	}
	return n, true
}

// HeaderInt parses a header that must be a positive integer, clamped to max.
// Digits only: exponent notation ("1e999") must not sneak past the gate, which
// is exactly the input that used to reach setTimeout as NaN.
func HeaderInt(raw string, max int64) (int64, bool) {
	t := trimSpace(raw)
	if t == "" || !allDigits(t) {
		return 0, false
	}
	n, err := strconv.ParseInt(t, 10, 64)
	if err != nil {
		// longer than int64 but all digits: unambiguously past the ceiling
		return max, true
	}
	if n <= 0 {
		return 0, false
	}
	if n > max {
		return max, true
	}
	return n, true
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return len(s) > 0
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && isSpace(s[start]) {
		start++
	}
	for end > start && isSpace(s[end-1]) {
		end--
	}
	return s[start:end]
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'
}
